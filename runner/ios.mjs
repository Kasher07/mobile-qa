// Safari on the iOS Simulator: safaridriver (WebDriver) navigates and scrolls, simctl screenshots the whole
// device screen (Safari bars and notch included). Falls back to simctl openurl + one screenshot if WebDriver fails.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readUrls, slug, probe, sleep, writeResults, maxSegments, newPage, segmentPlan, saveResults, withTimeout, PAGE_LIMIT_MS, JOB_BUDGET_MS } from './lib.mjs';

const STARTED = Date.now();

const OUT = path.resolve('out/ios');
fs.mkdirSync(OUT, { recursive: true });
const urls = readUrls();
const MAX_SEG = maxSegments();
const run = (cmd, args, opts) =>
  execFileSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }, opts));
const results = { platform: 'ios', device: null, browser: null, mode: null, notes: [], pages: [] };
const note = (s) => {
  console.log(s);
  results.notes.push(s);
};

function rankDevices() {
  const j = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  const want = (process.env.IOS_DEVICE || '').trim();
  const list = [];
  for (const [rt, devs] of Object.entries(j.devices)) {
    const m = rt.match(/iOS-(\d+)-(\d+)/);
    if (!m) continue;
    const ver = Number(m[1]) * 100 + Number(m[2]);
    for (const d of devs) {
      if (d.isAvailable === false) continue;
      const fit = want ? d.name === want : /^iPhone \d+$/.test(d.name);
      if (!fit) continue;
      list.push({ name: d.name, udid: d.udid, runtime: 'iOS ' + m[1] + '.' + m[2], score: ver * 1000 + Number((d.name.match(/\d+/) || [0])[0]) });
    }
  }
  if (!list.length) {
    const names = [...new Set(Object.values(j.devices).flat().filter((d) => /^iPhone/.test(d.name)).map((d) => d.name))];
    throw new Error('no iOS simulator matches "' + (want || 'iPhone NN') + '"; available: ' + names.join(', '));
  }
  return list.sort((a, b) => b.score - a.score);
}

function boot(d) {
  try {
    run('xcrun', ['simctl', 'boot', d.udid]);
  } catch (e) {
    if (!/Booted/.test(String(e.stderr))) throw e;
  }
  run('xcrun', ['simctl', 'bootstatus', d.udid, '-b'], { timeout: 600000 });
  try {
    run('xcrun', ['simctl', 'status_bar', d.udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--cellularBars', '4', '--wifiBars', '3']);
  } catch {}
}

const candidates = rankDevices();
let dev = candidates[0];

function shot(file) {
  const p = path.join(OUT, file);
  run('xcrun', ['simctl', 'io', dev.udid, 'screenshot', '--type=jpeg', p]);
  try {
    run('sips', ['-Z', '1600', '-s', 'formatOptions', '72', p]);
  } catch {}
  return file;
}

// Safari's first-run tips (iOS 26: "View Bookmarks, Share Menu, and Open Tabs") cover the page; AXe reads the
// accessibility tree and taps the tip's Close button. Only buttons near a tip text are tapped, never page content.
let axe = null;
try {
  run('sh', ['-c', 'command -v axe']);
  axe = 'axe';
} catch {
  console.log('AXe not installed: Safari tips may stay on screen');
}
const TIP_TEXT = /View Bookmarks|You can (now|change this)|Safari settings|Try it out|New in Safari/i;
const CLOSE_LABEL = /^(Close|Dismiss|Not Now|OK|Continue|Done)$/i;
let treeSaved = false;
function uiNodes() {
  const raw = JSON.parse(run('axe', ['describe-ui', '--udid', dev.udid]));
  if (!treeSaved) {
    fs.writeFileSync(path.join(OUT, 'ui-tree.json'), JSON.stringify(raw, null, 1));
    treeSaved = true;
  }
  const nodes = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    const label = o.AXLabel || o.label || o.AXValue || '';
    const f = o.frame || o.AXFrame;
    if (label && f && typeof f === 'object') nodes.push({ label: String(label), type: String(o.type || o.role || ''), x: f.x, y: f.y, w: f.width, h: f.height });
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
  };
  walk(raw);
  return nodes;
}
async function dismissTips() {
  if (!axe) return;
  for (let round = 0; round < 3; round++) {
    let nodes;
    try {
      nodes = uiNodes();
    } catch (e) {
      console.log('describe-ui failed: ' + String(e.stderr || e).slice(0, 200));
      return;
    }
    const tip = nodes.find((n) => TIP_TEXT.test(n.label));
    if (!tip) return;
    const btn = nodes
      .filter((n) => CLOSE_LABEL.test(n.label.trim()) && /button/i.test(n.type) && Math.abs(n.y - tip.y) < 400)
      .sort((a, b) => Math.abs(a.y - tip.y) - Math.abs(b.y - tip.y))[0];
    if (!btn) {
      console.log('tip found but no close button: ' + tip.label.slice(0, 80));
      return;
    }
    console.log('closing Safari tip "' + tip.label.slice(0, 60) + '" via ' + btn.label);
    try {
      run('axe', ['tap', '-x', String(Math.round(btn.x + btn.w / 2)), '-y', String(Math.round(btn.y + btn.h / 2)), '--udid', dev.udid]);
    } catch (e) {
      console.log('tap failed: ' + String(e.stderr || e).slice(0, 200));
      return;
    }
    await sleep(800);
  }
}

let sid = null;
let driver = null;
async function wd(method, p, body, attempt = 0) {
  let r;
  try {
    r = await fetch('http://127.0.0.1:4444' + p, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    // safaridriver drops a connection now and then ("fetch failed"): retry the same command twice.
    if (attempt < 2 && !/aborted|timeout/i.test(String(e.name) + String(e.message))) {
      await sleep(2000);
      return wd(method, p, body, attempt + 1);
    }
    throw new Error('webdriver ' + method + ' ' + p.replace(/\/session\/[^/]+/, '') + ': ' + ((e.cause && e.cause.code) || e.message));
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(method + ' ' + p + ' ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j.value;
}
const exec = (script, args = []) => wd('POST', '/session/' + sid + '/execute/sync', { script, args });

async function startDriver() {
  try {
    run('sudo', ['safaridriver', '--enable']);
  } catch (e) {
    note('safaridriver --enable failed: ' + String(e.stderr || e).slice(0, 200));
  }
  const base = { browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true };
  // Session creation fails now and then on a fresh runner: restart safaridriver and try again (3 rounds).
  for (let round = 1; round <= 3; round++) {
    if (driver) driver.kill();
    driver = spawn('safaridriver', ['-p', '4444'], { stdio: 'inherit' });
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fetch('http://127.0.0.1:4444/status')).ok) break;
      } catch {}
      await sleep(500);
    }
    for (const caps of [Object.assign({ 'safari:deviceUDID': dev.udid }, base), base]) {
      try {
        const v = await wd('POST', '/session', { capabilities: { alwaysMatch: caps } });
        sid = v.sessionId;
        await wd('POST', '/session/' + sid + '/timeouts', { pageLoad: 60000, script: 30000 }).catch(() => {});
        const got = v.capabilities && v.capabilities['safari:deviceUDID'];
        if (got && got !== dev.udid) {
          note('safaridriver picked another simulator ' + got);
          dev.udid = got;
        }
        console.log('webdriver session ok (round ' + round + ')');
        return true;
      } catch (e) {
        note('session round ' + round + ' failed: ' + e.message.slice(0, 200));
      }
    }
    await sleep(10000);
  }
  return false;
}

// Close Safari's first-run tips before automation starts: a tap during a WebDriver session makes Safari show
// "Safari is Running an Automated Test" over the page. The dismissal persists, so the automated Safari opens clean.
// Taps happen only here, on a fixed neutral page, never on a page under test.
async function warmUp() {
  if (!axe || !urls.length) return;
  try {
    run('xcrun', ['simctl', 'openurl', dev.udid, 'https://example.com/']);
    await sleep(8000);
    await dismissTips();
    await sleep(1000);
    await dismissTips();
    run('xcrun', ['simctl', 'terminate', dev.udid, 'com.apple.mobilesafari']);
    await sleep(1500);
  } catch (e) {
    note('warm-up failed on ' + dev.name + ': ' + String(e.stderr || e.message || e).slice(0, 200));
  }
}
// Some runner images carry a simulator whose Safari never accepts automation (and even openurl fails): try the next
// best device before giving up (2026-11-18: the same UDID failed in two baselines while others worked).
let hasWd = false;
for (const [n, cand] of candidates.slice(0, 3).entries()) {
  dev = cand;
  results.device = dev.name + ' / ' + dev.runtime;
  results.browser = 'Safari (' + dev.runtime + ')';
  console.log('device ' + results.device + ' ' + dev.udid);
  try {
    boot(dev);
  } catch (e) {
    note('boot failed on ' + dev.name + ' ' + dev.udid + ': ' + String(e.stderr || e.message).slice(0, 160));
    continue;
  }
  await warmUp();
  hasWd = await startDriver();
  if (hasWd) break;
  note('no WebDriver session on ' + dev.name + ' ' + dev.runtime + ' ' + dev.udid + (n < 2 ? ', trying the next simulator' : ''));
  if (driver) driver.kill();
  driver = null;
  if (n < Math.min(2, candidates.length - 1)) {
    try {
      run('xcrun', ['simctl', 'shutdown', dev.udid]);
    } catch {}
  }
}
results.mode = hasWd ? 'webdriver' : 'openurl';
for (const [i, url] of urls.entries()) {
  const name = slug(url, i);
  const cur = newPage(url, name);
  results.pages.push(cur);
  if (Date.now() - STARTED > JOB_BUDGET_MS) {
    cur.error = 'not checked: the job time budget was used by earlier pages';
    saveResults(OUT, results);
    continue;
  }
  console.log('[' + (i + 1) + '/' + urls.length + '] ' + url);
  try {
    if (hasWd) {
      await wd('POST', '/session/' + sid + '/url', { url });
      await sleep(2000);
      await exec('window.scrollTo(0, 0);');
      cur.probe = await exec('return (' + probe.toString() + ')();');
      cur.status = cur.probe.navStatus;
      if (!cur.status) {
        // Safari may not expose responseStatus: ask the server directly (same URL, from the runner).
        try {
          // Browser UA: some sites (Cloudflare bot rules, anti-scraping) answer 403 to a bare client.
          const ua = await exec('return navigator.userAgent;').catch(() => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
          cur.status = (await fetch(url, { redirect: 'follow', headers: { 'user-agent': ua, accept: 'text/html' }, signal: AbortSignal.timeout(20000) })).status;
          cur.statusSource = 'server request from the runner';
        } catch (e) {
          cur.error = 'unreachable: ' + String((e.cause && e.cause.code) || e.message).slice(0, 120);
        }
      }
      const vh = cur.probe.innerHeight || 700;
      const plan = segmentPlan(cur.probe.scrollHeight, vh, MAX_SEG);
      cur.segmentsNeeded = plan.needed;
      const segs = plan.count;
      for (let k = 0; k < segs; k++) {
        if (k > 0) await exec('window.scrollTo(0, arguments[0]);', [Math.round(k * vh * 0.9)]);
        await sleep(k === 0 ? 300 : 700);
        cur.shots.push(shot(name + '-' + String(k + 1).padStart(2, '0') + '.jpg'));
      }
    } else {
      try {
        run('xcrun', ['simctl', 'openurl', dev.udid, url]);
      } catch (e) {
        note('openurl failed once: ' + String(e.stderr || e.message).slice(0, 200));
        await sleep(5000);
        run('xcrun', ['simctl', 'openurl', dev.udid, url]);
      }
      await sleep(9000);
      cur.shots.push(shot(name + '-01.jpg'));
    }
  } catch (e) {
    cur.error = String(e.message || e).split('\n')[0].slice(0, 300);
    try {
      cur.shots.push(shot(name + '-error.jpg'));
    } catch {}
  }
  saveResults(OUT, results);
}
if (sid) await wd('DELETE', '/session/' + sid).catch(() => {});
if (driver) driver.kill();
writeResults(OUT, results);
