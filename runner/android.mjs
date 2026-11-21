// Chrome on the Android emulator, driven by Playwright's Android API; screenshots come from the device itself
// (Chrome toolbar and system bars included), so they show what a phone user sees.
import fs from 'node:fs';
import path from 'node:path';
import { _android as android } from 'playwright-core';
import { loadPrivateJob, installPrivateLogging, toPlaywrightCookies } from './private.mjs';
import { readUrls, slug, probe, writeResults, maxSegments, newPage, segmentPlan, saveResults, withTimeout, PAGE_LIMIT_MS, JOB_BUDGET_MS } from './lib.mjs';

const STARTED = Date.now();

const OUT = path.resolve('out/android');
fs.mkdirSync(OUT, { recursive: true });
// Private run (qa-agent site): sealed job with the session cookies; the log keeps page numbers only; read-only.
const PRIV = loadPrivateJob();
if (PRIV) installPrivateLogging(PRIV);
const urls = PRIV ? PRIV.urls : readUrls();
const blocked = [];
const MAX_SEG = maxSegments();
const results = { platform: 'android', device: null, browser: null, mode: 'playwright-android', notes: [], pages: [] };

const [device] = await android.devices();
if (!device) throw new Error('no adb device');
const sh = async (c) => (await device.shell(c)).toString().trim();
results.device = (await sh('getprop ro.product.model')) + ' / Android ' + (await sh('getprop ro.build.version.release'));
results.browser = 'Chrome ' + (await sh('dumpsys package com.android.chrome 2>/dev/null | grep -m1 versionName')).replace(/.*versionName=/, '');
console.log('device ' + results.device + ' | ' + results.browser);
await sh('am set-debug-app --persistent com.android.chrome').catch(() => {});
// Without the permission Chrome opens a full-screen "Chrome notifications" promo over the first page.
await sh('pm grant com.android.chrome android.permission.POST_NOTIFICATIONS').catch(() => {});
// A slow emulator raises "Pixel Launcher isn't responding" dialogs over Chrome: hide them, and check focus before
// every screenshot so a covered screen is reported instead of passing as a page screenshot.
await sh('settings put global hide_error_dialogs 1').catch(() => {});
async function focusedWindow() {
  const out = await sh('dumpsys window | grep -m1 mCurrentFocus').catch(() => '');
  return out.replace(/.*mCurrentFocus=/, '').trim();
}
async function ensureChromeOnTop(cur) {
  for (let t = 0; t < 3; t++) {
    const w = await focusedWindow();
    if (!w || /com\.android\.chrome/.test(w)) return;
    console.log('window over Chrome: ' + w.slice(0, 120));
    await sh('am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS').catch(() => {});
    await page.waitForTimeout(800);
    if (t === 2) cur.overlay = w.slice(0, 160);
  }
}

let context = await device.launchBrowser();
if (PRIV) {
  await context.addCookies(toPlaywrightCookies(PRIV));
  console.log('[private] cookies set: ' + PRIV.cookies.length);
}
// Chrome sometimes closes its page or refuses new targets ("Target.createTarget: Not supported") mid-run: a fresh tab, and if
// that fails too, a restarted Chrome (new context, cookies set again).
async function newTab() {
  try {
    return await withTimeout(context.newPage(), 30000, 'new tab');
  } catch {
    await withTimeout(context.close(), 20000, 'close').catch(() => {});
    context = await device.launchBrowser();
    if (PRIV) await context.addCookies(toPlaywrightCookies(PRIV));
    return context.pages()[0] || (await context.newPage());
  }
}
let page = context.pages()[0] || (await context.newPage());
// A freshly booted emulator can lack DNS for a while; a page under test must not fail for that.
let netUp = false;
for (let t = 0; t < 12; t++) {
  try {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    netUp = true;
    break;
  } catch (e) {
    console.log('network not ready (' + String(e.message).split('\n')[0].slice(0, 80) + '), waiting');
    await page.waitForTimeout(5000);
  }
}
if (!netUp) {
  results.notes.push('the emulator network never came up before the first page (12 tries over ~2 min)');
  console.log('[private] emulator network not up');
}
async function gotoOnce(url) {
  try {
    return await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  } catch (e) {
    if (!/net::ERR_/.test(String(e.message))) throw e;
    console.log('retrying after ' + String(e.message).split('\n')[0].slice(0, 80));
    await page.waitForTimeout(5000);
    return page.goto(url, { waitUntil: 'load', timeout: 45000 });
  }
}
let cur = null;
// favicon.ico 404s are noise on almost every site.
const noise = (u) => /\/favicon\.ico(\?|$)/.test(u || '') || /^https:\/\/([a-z0-9-]+\.)*challenges\.cloudflare\.com\//.test(u || '');
// Console lines that are infrastructure, not the page: Cloudflare Page Shield's Report-Only CSP monitor and the probes
// Cloudflare Turnstile makes on purpose. Counted apart so a real error never hides among them.
const infraNoise = (t) => /^\[Report Only\]/.test(t) || /Refused to connect to 'data:,'/.test(t);
// Each page gets its own tab: a page left scrolled with work in flight blocked the next navigation in the same tab
// (Moioi baseline, 2026-11-18). Dialogs (beforeunload, alert) are accepted so they never hold a navigation.
function attach(p) {
  if (PRIV) {
    // Read-only: same-origin writes from the page are aborted and counted (as kit-qa shot does).
    p.route('**/*', (route) => {
      const req = route.request();
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && req.url().startsWith(PRIV.base + '/')) {
        blocked.push(req.method() + ' ' + new URL(req.url()).pathname);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    }).catch(() => {});
  }
  p.on('dialog', (d) => d.accept().catch(() => {}));
  p.on('console', (m) => {
    if (!cur || m.type() !== 'error' || noise((m.location() || {}).url)) return;
    if (infraNoise(m.text())) cur.infraNoise = (cur.infraNoise || 0) + 1;
    else cur.consoleErrors.push(m.text().slice(0, 300));
  });
  p.on('pageerror', (e) => {
    if (cur) cur.pageErrors.push(String((e && e.message) || e).slice(0, 300));
  });
  p.on('requestfailed', (r) => {
    if (r.failure() && /BLOCKED_BY_CLIENT/.test(r.failure().errorText)) return;
    const aborted = r.failure() && /ERR_ABORTED/.test(r.failure().errorText);
    let crossOrigin = false;
    try {
      crossOrigin = new URL(r.url()).origin !== new URL(p.url()).origin;
    } catch {}
    // Analytics beacons cut off by the next navigation are noise, not a broken page.
    if (cur && !noise(r.url()) && !(aborted && crossOrigin)) cur.failedRequests.push(((r.failure() && r.failure().errorText) || 'failed') + ' ' + r.url().slice(0, 200));
  });
  p.on('response', (r) => {
    if (cur && r.status() >= 400 && !noise(r.url())) cur.failedRequests.push(r.status() + ' ' + r.url().slice(0, 200));
  });
}
attach(page);

const stamp = (t0, s) => console.log('      ' + Math.round((Date.now() - t0) / 1000) + 's ' + s);
async function checkPage(cur, url, name) {
  const t0 = Date.now();
  const resp = await gotoOnce(url);
  stamp(t0, 'loaded');
  cur.status = resp ? resp.status() : null;
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  cur.probe = await page.evaluate(probe);
  stamp(t0, 'probed');
  // A JS challenge (Cloudflare/Vercel) usually clears itself for a real browser after a few seconds: give it two chances.
  for (let t = 0; t < 2 && cur.probe.challenge; t++) {
    await page.waitForTimeout(12000);
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    cur.probe = await page.evaluate(probe);
  }
  const vh = cur.probe.innerHeight || 700;
  const plan = segmentPlan(cur.probe.scrollHeight, vh, MAX_SEG);
  cur.segmentsNeeded = plan.needed;
  for (let k = 0; k < plan.count; k++) {
    if (k > 0) await page.evaluate((y) => window.scrollTo(0, y), Math.round(k * vh * 0.9));
    await page.waitForTimeout(k === 0 ? 300 : 600);
    await ensureChromeOnTop(cur);
    const f = name + '-' + String(k + 1).padStart(2, '0') + '.png';
    fs.writeFileSync(path.join(OUT, f), await withTimeout(device.screenshot(), 30000, 'screenshot'));
    cur.shots.push(f);
    stamp(t0, 'screen ' + (k + 1));
  }
}

for (const [i, url] of urls.entries()) {
  const name = PRIV ? 'p' + String(i + 1).padStart(2, '0') : slug(url, i);
  cur = newPage(url, name);
  results.pages.push(cur);
  if (Date.now() - STARTED > JOB_BUDGET_MS) {
    cur.error = 'not checked: the job time budget was used by earlier pages';
    saveResults(OUT, results);
    continue;
  }
  if (i > 0) {
    const prev = page;
    page = await withTimeout(context.newPage(), 30000, 'new tab').catch(() => page);
    if (page !== prev) {
      attach(page);
      prev.close({ runBeforeUnload: false }).catch(() => {});
    }
  }
  console.log('[' + (i + 1) + '/' + urls.length + '] ' + (PRIV ? '' : url));
  const blockedBefore = blocked.length;
  const t0 = Date.now();
  try {
    try {
      await withTimeout(checkPage(cur, url, name), PAGE_LIMIT_MS, 'page');
    } catch (e) {
      // The emulator stalls now and then in its first minutes (launcher ANRs): one more try in a fresh tab. A page that
      // really hangs fails again and is reported; a retry is always written in the notes.
      if (!/did not finish|net::ERR_|has been closed/.test(String(e.message)) || Date.now() - STARTED > JOB_BUDGET_MS - PAGE_LIMIT_MS) throw e;
      console.log('    retrying after: ' + String(e.message).split('\n')[0].slice(0, 100));
      cur.retried = String(e.message).split('\n')[0].slice(0, 120);
      for (const f of cur.shots) fs.rmSync(path.join(OUT, f), { force: true });
      cur.shots = [];
      cur.consoleErrors = [];
      cur.pageErrors = [];
      cur.failedRequests = [];
      const prev = page;
      page = await newTab();
      attach(page);
      prev.close({ runBeforeUnload: false }).catch(() => {});
      await withTimeout(checkPage(cur, url, name), PAGE_LIMIT_MS, 'page (retry)');
    }
  } catch (e) {
    cur.error = String((e && e.message) || e).split('\n')[0].slice(0, 300);
    if (PRIV) results.notes.push('error detail ' + (i + 1) + ': ' + String((e && e.stack) || e).slice(0, 600) + ' | logcat: ' + (await sh("logcat -d -t 400 | grep -i -E 'FATAL|crash|lmkd|Killing|Out of memory|renderer' | tail -6").catch(() => '')).slice(0, 900));
    try {
      const f = name + '-error.png';
      fs.writeFileSync(path.join(OUT, f), await withTimeout(device.screenshot(), 20000, 'screenshot'));
      cur.shots.push(f);
    } catch {}
  }
  if (PRIV) cur.blockedWrites = blocked.slice(blockedBefore);
  console.log('    ' + (cur.error ? (PRIV ? 'error' : 'error: ' + cur.error) : 'ok') + ' in ' + Math.round((Date.now() - t0) / 1000) + ' s, ' + cur.shots.length + ' screens');
  saveResults(OUT, results);
}
cur = null;
// Results first: closing Chrome or adb has hung before, and nothing may stop the upload step.
writeResults(OUT, results);
await withTimeout(context.close(), 20000, 'close').catch(() => {});
await withTimeout(device.close(), 20000, 'adb close').catch(() => {});
process.exit(0);
