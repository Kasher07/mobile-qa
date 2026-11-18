// Safari on the iOS Simulator: safaridriver (WebDriver) navigates and scrolls, simctl screenshots the whole
// device screen (Safari bars and notch included). Falls back to simctl openurl + one screenshot if WebDriver fails.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readUrls, slug, probe, sleep, writeResults, maxSegments, newPage } from './lib.mjs';

const OUT = path.resolve('out/ios');
fs.mkdirSync(OUT, { recursive: true });
const urls = readUrls();
const MAX_SEG = maxSegments();
const run = (cmd, args, opts) =>
  execFileSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }, opts));
const results = { platform: 'ios', device: null, browser: null, mode: null, pages: [] };

function pickDevice() {
  const j = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '-j']));
  const want = (process.env.IOS_DEVICE || '').trim();
  let best = null;
  for (const [rt, devs] of Object.entries(j.devices)) {
    const m = rt.match(/iOS-(\d+)-(\d+)/);
    if (!m) continue;
    const ver = Number(m[1]) * 100 + Number(m[2]);
    for (const d of devs) {
      if (d.isAvailable === false) continue;
      const fit = want ? d.name === want : /^iPhone \d+$/.test(d.name);
      if (!fit) continue;
      const score = ver * 1000 + Number((d.name.match(/\d+/) || [0])[0]);
      if (!best || score > best.score) best = { name: d.name, udid: d.udid, runtime: 'iOS ' + m[1] + '.' + m[2], score };
    }
  }
  if (!best) throw new Error('no iOS simulator matches ' + (want || 'iPhone NN'));
  return best;
}

const dev = pickDevice();
results.device = dev.name + ' / ' + dev.runtime;
results.browser = 'Safari (' + dev.runtime + ')';
console.log('device ' + results.device + ' ' + dev.udid);
try {
  run('xcrun', ['simctl', 'boot', dev.udid]);
} catch (e) {
  if (!/Booted/.test(String(e.stderr))) throw e;
}
run('xcrun', ['simctl', 'bootstatus', dev.udid, '-b'], { timeout: 600000 });
try {
  run('xcrun', ['simctl', 'status_bar', dev.udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--cellularBars', '4', '--wifiBars', '3']);
} catch {}

function shot(file) {
  const p = path.join(OUT, file);
  run('xcrun', ['simctl', 'io', dev.udid, 'screenshot', '--type=jpeg', p]);
  try {
    run('sips', ['-Z', '1600', '-s', 'formatOptions', '72', p]);
  } catch {}
  return file;
}

let sid = null;
let driver = null;
async function wd(method, p, body) {
  const r = await fetch('http://127.0.0.1:4444' + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(method + ' ' + p + ' ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j.value;
}
const exec = (script, args = []) => wd('POST', '/session/' + sid + '/execute/sync', { script, args });

async function startDriver() {
  try {
    run('sudo', ['safaridriver', '--enable']);
  } catch (e) {
    console.log('safaridriver --enable failed: ' + String(e.stderr || e).slice(0, 200));
  }
  driver = spawn('safaridriver', ['-p', '4444'], { stdio: 'inherit' });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch('http://127.0.0.1:4444/status')).ok) break;
    } catch {}
    await sleep(500);
  }
  const base = { browserName: 'safari', platformName: 'iOS', 'safari:useSimulator': true };
  for (const caps of [Object.assign({ 'safari:deviceUDID': dev.udid }, base), base]) {
    try {
      const v = await wd('POST', '/session', { capabilities: { alwaysMatch: caps } });
      sid = v.sessionId;
      const got = v.capabilities && v.capabilities['safari:deviceUDID'];
      if (got && got !== dev.udid) {
        console.log('safaridriver picked another simulator ' + got);
        dev.udid = got;
      }
      console.log('webdriver session ok');
      return true;
    } catch (e) {
      console.log('session failed: ' + e.message);
    }
  }
  return false;
}

const hasWd = await startDriver();
results.mode = hasWd ? 'webdriver' : 'openurl';
for (const [i, url] of urls.entries()) {
  const name = slug(url, i);
  const cur = newPage(url, name);
  results.pages.push(cur);
  try {
    if (hasWd) {
      await wd('POST', '/session/' + sid + '/url', { url });
      await sleep(2000);
      await exec('window.scrollTo(0, 0);');
      cur.probe = await exec('return (' + probe.toString() + ')();');
      cur.status = cur.probe.navStatus;
      const vh = cur.probe.innerHeight || 700;
      const segs = Math.min(MAX_SEG, Math.max(1, Math.ceil(cur.probe.scrollHeight / vh)));
      for (let k = 0; k < segs; k++) {
        if (k > 0) await exec('window.scrollTo(0, arguments[0]);', [Math.round(k * vh * 0.9)]);
        await sleep(k === 0 ? 300 : 700);
        cur.shots.push(shot(name + '-' + String(k + 1).padStart(2, '0') + '.jpg'));
      }
    } else {
      run('xcrun', ['simctl', 'openurl', dev.udid, url]);
      await sleep(9000);
      cur.shots.push(shot(name + '-01.jpg'));
    }
  } catch (e) {
    cur.error = String(e.message || e).split('\n')[0].slice(0, 300);
    try {
      cur.shots.push(shot(name + '-error.jpg'));
    } catch {}
  }
}
if (sid) await wd('DELETE', '/session/' + sid).catch(() => {});
if (driver) driver.kill();
writeResults(OUT, results);
