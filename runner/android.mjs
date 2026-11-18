// Chrome on the Android emulator, driven by Playwright's Android API; screenshots come from the device itself
// (Chrome toolbar and system bars included), so they show what a phone user sees.
import fs from 'node:fs';
import path from 'node:path';
import { _android as android } from 'playwright-core';
import { readUrls, slug, probe, writeResults, maxSegments, newPage } from './lib.mjs';

const OUT = path.resolve('out/android');
fs.mkdirSync(OUT, { recursive: true });
const urls = readUrls();
const MAX_SEG = maxSegments();
const results = { platform: 'android', device: null, browser: null, mode: 'playwright-android', pages: [] };

const [device] = await android.devices();
if (!device) throw new Error('no adb device');
const sh = async (c) => (await device.shell(c)).toString().trim();
results.device = (await sh('getprop ro.product.model')) + ' / Android ' + (await sh('getprop ro.build.version.release'));
results.browser = 'Chrome ' + (await sh('dumpsys package com.android.chrome | grep versionName | head -1')).replace(/.*versionName=/, '');
console.log('device ' + results.device + ' | ' + results.browser);
await sh('am set-debug-app --persistent com.android.chrome').catch(() => {});

const context = await device.launchBrowser();
const page = context.pages()[0] || (await context.newPage());
let cur = null;
page.on('console', (m) => {
  if (cur && m.type() === 'error') cur.consoleErrors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => {
  if (cur) cur.pageErrors.push(String((e && e.message) || e).slice(0, 300));
});
page.on('requestfailed', (r) => {
  if (cur) cur.failedRequests.push(((r.failure() && r.failure().errorText) || 'failed') + ' ' + r.url().slice(0, 200));
});
page.on('response', (r) => {
  if (cur && r.status() >= 400) cur.failedRequests.push(r.status() + ' ' + r.url().slice(0, 200));
});

for (const [i, url] of urls.entries()) {
  const name = slug(url, i);
  cur = newPage(url, name);
  results.pages.push(cur);
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 45000 });
    cur.status = resp ? resp.status() : null;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    cur.probe = await page.evaluate(probe);
    const vh = cur.probe.innerHeight || 700;
    const segs = Math.min(MAX_SEG, Math.max(1, Math.ceil(cur.probe.scrollHeight / vh)));
    for (let k = 0; k < segs; k++) {
      if (k > 0) await page.evaluate((y) => window.scrollTo(0, y), Math.round(k * vh * 0.9));
      await page.waitForTimeout(k === 0 ? 300 : 600);
      const f = name + '-' + String(k + 1).padStart(2, '0') + '.png';
      fs.writeFileSync(path.join(OUT, f), await device.screenshot());
      cur.shots.push(f);
    }
  } catch (e) {
    cur.error = String((e && e.message) || e).split('\n')[0].slice(0, 300);
    try {
      const f = name + '-error.png';
      fs.writeFileSync(path.join(OUT, f), await device.screenshot());
      cur.shots.push(f);
    } catch {}
  }
}
cur = null;
await context.close().catch(() => {});
await device.close().catch(() => {});
writeResults(OUT, results);
