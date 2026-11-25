#!/usr/bin/env node
// app-qa widget step (shard pass "widgets"): puts the app's home-screen widgets on the device, photographs them and runs
// the app's optional widget flows. Called by runner/app-android.sh (emulator up, app installed, launchers off) and by
// runner/app-widgets-ios.sh (simulator booted, app installed).
//   node runner/app-widgets.mjs android|ios
// env: OUT (result folder), APP_ID, WIDGETS (JSON from bin/app-qa.mjs, see widgetPlan in bin/app-qa-widgets.mjs),
//      FLOWS (the app's .maestro folder), UDID (iOS).
// Order: (1) the app runs once (.maestro/widgets/setup.yaml, else launch + 20 s) so it writes its widget data;
// (2) Android: the bundled widget host (runner/widget-host, an AppWidgetHost: the emulator keeps its launcher off)
//     binds every widget at its target cell size; iOS: SpringBoard's own widget gallery adds each kind and size to the
//     home screen (Maestro taps "Edit" > "Add Widget"), then lock-screen widgets (best effort);
// (3) screenshots in light and dark (iOS also Tinted) in OUT/widgets; (4) .maestro/widgets/after.yaml, if any, runs on
//     the screen with the widgets (e.g. press a widget button, open the app, check it); then one more screenshot.
// Results: OUT/junit.xml (one test case per step; best-effort steps are "skipped" when they fail), OUT/widgets/*.png.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { iosAddFlow, iosLockFlow, iosShootFlow, iosTintFlow, junitXml, setupFlow } from './widgets-flows.mjs';

const platform = process.argv[2];
if (!/^(android|ios)$/.test(platform || '')) { console.error('usage: app-widgets.mjs android|ios'); process.exit(2); }
const OUT = path.resolve(process.env.OUT || 'out');
const APP_ID = process.env.APP_ID;
const FLOWS = process.env.FLOWS;
const UDID = process.env.UDID || '';
const W = JSON.parse(process.env.WIDGETS || '{}');
const SHOTS = path.join(OUT, 'widgets');
const GEN = path.join(OUT, 'gen');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(GEN, { recursive: true });
const cases = [];
const log = (s) => console.log('[widgets ' + platform + '] ' + s);
const run = (cmd, args, o = {}) => spawnSync(cmd, args, { encoding: o.buffer ? undefined : 'utf8', maxBuffer: 64 << 20, timeout: o.timeout || 600000, ...o });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const record = (name, ok, msg, best) => { cases.push({ name, ok, msg, skipped: !ok && !!best }); log((ok ? 'ok   ' : best ? 'skip ' : 'FAIL ') + name + (msg ? ' - ' + msg : '')); };

/** Runs one Maestro flow file; its takeScreenshot files land in OUT/widgets. On failure keeps the screen's hierarchy. */
function maestro(name, file) {
  const junit = path.join(GEN, 'junit-' + name + '.xml');
  const args = [...(UDID ? ['--device', UDID] : []), 'test', '--format', 'junit', '--output', junit, '--test-output-dir', path.join(GEN, 'maestro-' + name), file];
  const r = run('maestro', args, { cwd: SHOTS, timeout: 900000 });
  fs.writeFileSync(path.join(GEN, 'maestro-' + name + '.log'), (r.stdout || '') + (r.stderr || ''));
  const xml = fs.existsSync(junit) ? fs.readFileSync(junit, 'utf8') : '';
  const ok = r.status === 0 && !/<failure/.test(xml);
  if (!ok) {
    const h = run('maestro', [...(UDID ? ['--device', UDID] : []), 'hierarchy'], { timeout: 300000 });
    fs.writeFileSync(path.join(GEN, 'hierarchy-' + name + '.json'), h.stdout || '');
    shot('fail-' + name);
  }
  const msg = ok ? '' : ((xml.match(/<failure[^>]*>([^<]{0,300})/) || xml.match(/message="([^"]{0,300})"/) || [])[1] || 'maestro exit ' + r.status).trim();
  return { ok, msg };
}
const writeFlow = (name, yaml) => { const f = path.join(GEN, name + '.yaml'); fs.writeFileSync(f, yaml); return f; };
const appFlow = (name) => (FLOWS && fs.existsSync(path.join(FLOWS, 'widgets', name + '.yaml')) ? path.join(FLOWS, 'widgets', name + '.yaml') : null);

function shot(name) {
  const file = path.join(SHOTS, name + '.png');
  if (platform === 'android') {
    const r = run('adb', ['exec-out', 'screencap', '-p'], { buffer: true });
    if (r.status === 0 && r.stdout?.length) fs.writeFileSync(file, r.stdout);
  } else run('xcrun', ['simctl', 'io', UDID, 'screenshot', file]);
  return file;
}

function setup() {
  const own = appFlow('setup');
  const r = maestro('setup', own || writeFlow('setup', setupFlow(APP_ID, platform)));
  record('widgets ' + platform + ': app ran once (' + (own ? 'widgets/setup.yaml' : 'launch + 20 s') + ')', r.ok, r.msg);
  return r.ok;
}

// ---------------- Android: the bundled widget host
const adb = (...a) => run('adb', a);
function hostShow(names, page) {
  adb('logcat', '-c');
  adb('shell', 'am', 'start', '-W', ...(page === 0 ? ['-S'] : []), '-n', 'qa.widgethost/.HostActivity', '--es', 'pkg', APP_ID, '--es', 'only', names.join(','), '--ei', 'page', String(page));
  // Every widget sends its views once its provider has rendered (Glance: a first pass, then the real one).
  let text = '';
  const until = Date.now() + 45000;
  for (;;) {
    text = adb('logcat', '-d', '-s', 'QaWidgetHost:*').stdout || '';
    const updated = new Set([...text.matchAll(/ update (\S+)/g)].map((m) => m[1]));
    if (names.every((n) => updated.has(n)) && /pages \d+/.test(text) || Date.now() > until) break;
    sleep(1000);
  }
  sleep(3000); // a second update (the real content after a loading pass) settles
  text = adb('logcat', '-d', '-s', 'QaWidgetHost:*').stdout || '';
  fs.appendFileSync(path.join(OUT, 'widget-host.log'), text);
  const updated = new Set([...text.matchAll(/ update (\S+)/g)].map((m) => m[1]));
  return {
    pages: Number((text.match(/pages (\d+)/) || [])[1] || 1),
    missing: names.filter((n) => !updated.has(n)),
    errors: [...new Set([...text.matchAll(/ (error|bind-refused) (\S+)/g)].map((m) => m[1] + ' ' + m[2]))],
  };
}

function android() {
  const names = W.android || [];
  if (!names.length) { record('widgets android: none declared', true, ''); return; }
  const apk = path.join(process.env.RUNNER_TEMP || GEN, 'widget-host.apk');
  const b = run('bash', [path.join(import.meta.dirname, 'widget-host-build.sh'), apk]);
  fs.writeFileSync(path.join(GEN, 'widget-host-build.log'), (b.stdout || '') + (b.stderr || ''));
  if (b.status !== 0) { record('widgets android: build the widget host', false, (b.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)); return; }
  adb('install', '-r', apk);
  const g = adb('shell', 'appwidget', 'grantbind', '--package', 'qa.widgethost', '--user', '0');
  if (g.status !== 0) { record('widgets android: grant the host the bind permission', false, (g.stderr || g.stdout || '').trim().slice(0, 200)); return; }
  if (!setup()) return;
  for (const mode of ['light', 'dark']) {
    adb('shell', 'cmd', 'uimode', 'night', mode === 'dark' ? 'yes' : 'no');
    sleep(2000);
    let res = hostShow(names, 0);
    const files = [shot('android-' + mode + '-1')];
    for (let p = 1; p < res.pages; p++) { const r = hostShow(names, p); res = { ...res, missing: [...new Set([...res.missing, ...r.missing])] }; files.push(shot('android-' + mode + '-' + (p + 1))); }
    const ok = !res.missing.length && !res.errors.length;
    record('widgets android ' + mode + ': ' + (names.length - res.missing.length) + '/' + names.length + ' drawn, ' + files.length + ' screenshot(s)', ok,
      [res.missing.length ? 'no views from ' + res.missing.join(', ') : '', res.errors.join(', ')].filter(Boolean).join('; '));
  }
  adb('shell', 'cmd', 'uimode', 'night', 'no');
  const after = appFlow('after');
  if (after) {
    hostShow(names, 0);
    const r = maestro('after', after);
    record('widgets android: widgets/after.yaml', r.ok, r.msg);
    const res = hostShow(names, 0);
    shot('android-after-1');
    for (let p = 1; p < res.pages; p++) { hostShow(names, p); shot('android-after-' + (p + 1)); }
  }
}

// ---------------- iOS: SpringBoard
const simui = (...a) => run('xcrun', ['simctl', 'ui', UDID, ...a]);
function dedupe(prefix) { // swiping past the last home page photographs it again
  const seen = new Set();
  for (const f of fs.readdirSync(SHOTS).filter((x) => x.startsWith(prefix)).sort()) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(SHOTS, f))).digest('hex');
    if (seen.has(h)) fs.rmSync(path.join(SHOTS, f)); else seen.add(h);
  }
}
function ios() {
  const home = W.ios || [];
  const lock = W.lock || [];
  if (!home.length && !lock.length) { record('widgets ios: none declared', true, ''); return; }
  if (!setup()) return;
  const sizes = { systemSmall: 4, systemMedium: 8, systemLarge: 16, systemExtraLarge: 32 };
  const cells = home.reduce((s, k) => s + k.families.reduce((t, f) => t + (sizes[f] || 8), 0), 0);
  const pages = 3 + Math.ceil(cells / 24);
  if (home.length) {
    simui('appearance', 'light');
    const added = maestro('add', writeFlow('add', iosAddFlow(W)));
    record('widgets ios: ' + home.reduce((s, k) => s + k.families.length, 0) + ' home-screen widgets added from the gallery', added.ok, added.msg);
    for (const mode of ['light', 'dark']) {
      simui('appearance', mode);
      sleep(3000);
      const r = maestro('shoot-' + mode, writeFlow('shoot-' + mode, iosShootFlow('ios-' + mode, pages)));
      dedupe('ios-' + mode + '-');
      record('widgets ios ' + mode + ': home screen pages photographed', r.ok, r.msg);
    }
    simui('appearance', 'light');
    const t = maestro('tinted', writeFlow('tinted', iosTintFlow('Tinted', pages)));
    dedupe('ios-tinted-');
    record('widgets ios tinted: home screen in Tinted mode', t.ok, t.msg, true);
    if (t.ok) maestro('untint', writeFlow('untint', iosTintFlow('Default', 0)));
  }
  if (lock.length) {
    const r = maestro('lock', writeFlow('lock', iosLockFlow(W)));
    record('widgets ios: lock screen widgets', r.ok, r.msg, true);
  }
  const after = appFlow('after');
  if (after) {
    const r = maestro('after', after);
    record('widgets ios: widgets/after.yaml', r.ok, r.msg);
    maestro('shoot-after', writeFlow('shoot-after', iosShootFlow('ios-after', pages)));
    dedupe('ios-after-');
  }
}

try {
  if (platform === 'android') android(); else ios();
} catch (e) {
  record('widgets ' + platform + ': step crashed', false, String(e.message).slice(0, 300));
}
fs.writeFileSync(path.join(OUT, 'junit.xml'), junitXml('widgets-' + platform, cases));
process.exit(cases.some((c) => !c.ok && !c.skipped) ? 1 : 0);
