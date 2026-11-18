// Chrome on the Android emulator, driven by Playwright's Android API; screenshots come from the device itself
// (Chrome toolbar and system bars included), so they show what a phone user sees.
import fs from 'node:fs';
import path from 'node:path';
import { _android as android } from 'playwright-core';
import { readUrls, slug, probe, writeResults, maxSegments, newPage, segmentPlan, saveResults, withTimeout, PAGE_LIMIT_MS, JOB_BUDGET_MS } from './lib.mjs';

const STARTED = Date.now();

const OUT = path.resolve('out/android');
fs.mkdirSync(OUT, { recursive: true });
const urls = readUrls();
const MAX_SEG = maxSegments();
const results = { platform: 'android', device: null, browser: null, mode: 'playwright-android', pages: [] };

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

const context = await device.launchBrowser();
let page = context.pages()[0] || (await context.newPage());
// A freshly booted emulator can lack DNS for a while; a page under test must not fail for that.
for (let t = 0; t < 12; t++) {
  try {
    await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    break;
  } catch (e) {
    console.log('network not ready (' + String(e.message).split('\n')[0].slice(0, 80) + '), waiting');
    await page.waitForTimeout(5000);
  }
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
const noise = (u) => /\/favicon\.ico(\?|$)/.test(u || '');
// Each page gets its own tab: a page left scrolled with work in flight blocked the next navigation in the same tab
// (Moioi baseline, 2026-11-18). Dialogs (beforeunload, alert) are accepted so they never hold a navigation.
function attach(p) {
  p.on('dialog', (d) => d.accept().catch(() => {}));
  p.on('console', (m) => {
    if (cur && m.type() === 'error' && !noise((m.location() || {}).url)) cur.consoleErrors.push(m.text().slice(0, 300));
  });
  p.on('pageerror', (e) => {
    if (cur) cur.pageErrors.push(String((e && e.message) || e).slice(0, 300));
  });
  p.on('requestfailed', (r) => {
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

async function checkPage(cur, url, name) {
  const resp = await gotoOnce(url);
  cur.status = resp ? resp.status() : null;
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  cur.probe = await page.evaluate(probe);
  const vh = cur.probe.innerHeight || 700;
  const plan = segmentPlan(cur.probe.scrollHeight, vh, MAX_SEG);
  cur.segmentsNeeded = plan.needed;
  for (let k = 0; k < plan.count; k++) {
    if (k > 0) await page.evaluate((y) => window.scrollTo(0, y), Math.round(k * vh * 0.9));
    await page.waitForTimeout(k === 0 ? 300 : 600);
    await ensureChromeOnTop(cur);
    const f = name + '-' + String(k + 1).padStart(2, '0') + '.png';
    fs.writeFileSync(path.join(OUT, f), await device.screenshot());
    cur.shots.push(f);
  }
}

for (const [i, url] of urls.entries()) {
  const name = slug(url, i);
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
  console.log('[' + (i + 1) + '/' + urls.length + '] ' + url);
  const t0 = Date.now();
  try {
    await withTimeout(checkPage(cur, url, name), PAGE_LIMIT_MS, 'page');
  } catch (e) {
    cur.error = String((e && e.message) || e).split('\n')[0].slice(0, 300);
    try {
      const f = name + '-error.png';
      fs.writeFileSync(path.join(OUT, f), await withTimeout(device.screenshot(), 20000, 'screenshot'));
      cur.shots.push(f);
    } catch {}
  }
  console.log('    ' + (cur.error ? 'error: ' + cur.error : 'ok') + ' in ' + Math.round((Date.now() - t0) / 1000) + ' s, ' + cur.shots.length + ' screens');
  saveResults(OUT, results);
}
cur = null;
// Results first: closing Chrome or adb has hung before, and nothing may stop the upload step.
writeResults(OUT, results);
await withTimeout(context.close(), 20000, 'close').catch(() => {});
await withTimeout(device.close(), 20000, 'adb close').catch(() => {});
process.exit(0);
