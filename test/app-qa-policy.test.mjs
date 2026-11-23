import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { describeDecision, iosRisk, selectFlows, splitByCoverage } from '../bin/app-qa-select.mjs';

const FLOWS = ['01-read', '02-translation', '03-screens', '04-resume'];
const MAP = {
  ignore: ['**/*.md', '**/*.test.ts', 'src/**/*.web.{ts,tsx}'],
  all: ['app.json', 'package.json', 'src/lib/bible/settings.ts'],
  rules: [
    { paths: ['src/app/(tabs)/kinh-thanh.tsx', 'src/lib/bible/reading-spot.ts'], flows: ['01-read', '04-resume'] },
    { paths: ['src/lib/bible/store.ts', 'src/lib/bible/manifest-check.ts'], flows: ['02-translation'] },
    { paths: ['src/lib/bible/dates.ts'], flows: ['03-screens'] },
  ],
  dark: { paths: ['src/app/**'], flows: ['03-screens'] },
  ios: { paths: ['app.json', 'package.json', 'plugins/**', 'assets/**', 'src/**/*.ios.{ts,tsx}'], content: 'NativeTabs|GlassView|useSafeAreaInsets|expo-font' },
};
const cov = (...f) => new Set(f);

const UNIT_ONLY_MAP = { ...MAP, unitOnly: ['src/lib/bible/dates.ts', 'src/lib/bible/pure/**'] };

test('splitByCoverage without a covered set (or without unitOnly) is exactly selectFlows for both platforms', () => {
  const changed = ['src/lib/bible/reading-spot.ts'];
  const r = splitByCoverage(MAP, changed, FLOWS, [], null);
  assert.deepEqual(r.android, selectFlows(MAP, changed, FLOWS, []));
  assert.deepEqual(r.ios, r.android);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(splitByCoverage(MAP, changed, FLOWS, [], cov()).ios, r.ios);
  assert.deepEqual(splitByCoverage(MAP, null, FLOWS, [], cov('x.ts')).ios.light, FLOWS); // never passed: everything
  // covered files that a rule lists keep their flows on BOTH platforms (the iOS run at land includes them) ...
  const listed = splitByCoverage(MAP, changed, FLOWS, [], cov('src/lib/bible/reading-spot.ts'));
  assert.deepEqual([listed.android.light, listed.ios.light], [['01-read', '04-resume'], ['01-read', '04-resume']]);
  // ... and a covered file that no rule lists is an unmapped file: every flow, never skipped
  const unmapped = splitByCoverage(MAP, ['src/lib/new-thing.ts'], FLOWS, [], cov('src/lib/new-thing.ts'));
  assert.deepEqual([unmapped.android.light, unmapped.ios.light, unmapped.skipped], [FLOWS, FLOWS, []]);
});

test('only an explicit unitOnly module that a green unit test covers is dropped from the selection, on both platforms', () => {
  const r = splitByCoverage(UNIT_ONLY_MAP, ['src/lib/bible/dates.ts'], FLOWS, [], cov('src/lib/bible/dates.ts'));
  assert.deepEqual([r.android.light, r.ios.light, r.skipped], [[], [], ['src/lib/bible/dates.ts']]);
  const notCovered = splitByCoverage(UNIT_ONLY_MAP, ['src/lib/bible/dates.ts'], FLOWS, [], cov());
  assert.deepEqual([notCovered.ios.light, notCovered.skipped], [['03-screens'], []]); // unit tests did not run green: its flow runs
  const mixed = splitByCoverage(UNIT_ONLY_MAP, ['src/lib/bible/dates.ts', 'src/lib/bible/manifest-check.ts'], FLOWS, [], cov('src/lib/bible/dates.ts', 'src/lib/bible/manifest-check.ts'));
  assert.deepEqual([mixed.ios.light, mixed.skipped], [['02-translation'], ['src/lib/bible/dates.ts']]);
});

test('covered does not shield: JSX files, "all" files, flow files and uncovered files keep their flows on both platforms', () => {
  const m = { ...UNIT_ONLY_MAP, unitOnly: [...UNIT_ONLY_MAP.unitOnly, 'src/app/**', 'src/lib/bible/settings.ts', '.maestro/**'] };
  const covered = cov('src/app/(tabs)/kinh-thanh.tsx', 'src/lib/bible/settings.ts', '.maestro/02-translation.yaml', 'src/lib/bible/store.ts');
  const tsx = splitByCoverage(m, ['src/app/(tabs)/kinh-thanh.tsx'], FLOWS, [], covered);
  assert.deepEqual([tsx.android.light, tsx.ios.light, tsx.skipped], [['01-read', '04-resume'], ['01-read', '04-resume'], []]);
  const all = splitByCoverage(m, ['src/lib/bible/settings.ts'], FLOWS, [], covered);
  assert.deepEqual([all.android.light.length, all.ios.light.length], [4, 4]);
  const flow = splitByCoverage(m, ['.maestro/02-translation.yaml'], FLOWS, [], covered);
  assert.deepEqual([flow.ios.light, flow.skipped], [['02-translation'], []]);
  const notCovered = splitByCoverage(m, ['src/lib/bible/manifest-check.ts'], FLOWS, [], covered);
  assert.deepEqual(notCovered.ios.light, ['02-translation']);
});

test('iosRisk: configs, native folders and iOS-only files count; plain JS screens do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-risk-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/plain.tsx'), 'export const A = () => null;');
    fs.writeFileSync(path.join(dir, 'src/tabs.tsx'), "import { NativeTabs } from 'expo-router/unstable-native-tabs';");
    assert.equal(iosRisk(MAP, ['src/plain.tsx', 'README.md'], dir), null);
    assert.equal(iosRisk(MAP, [], dir), null);
    assert.equal(iosRisk(MAP, ['src/plain.tsx', 'app.json'], dir), 'app.json');
    assert.equal(iosRisk(MAP, ['assets/fonts/a.ttf'], dir), 'assets/fonts/a.ttf');
    assert.equal(iosRisk(MAP, ['plugins/with-x.js'], dir), 'plugins/with-x.js');
    assert.equal(iosRisk(MAP, ['src/x.ios.tsx'], dir), 'src/x.ios.tsx');
    assert.match(iosRisk(MAP, ['src/tabs.tsx'], dir), /src\/tabs\.tsx \(iOS-specific code\)/);
    assert.equal(iosRisk(MAP, ['.maestro/03-screens.yaml'], dir), '.maestro/03-screens.yaml');
    assert.equal(iosRisk(MAP, ['src/deleted.tsx'], dir), null); // unreadable: not a risk by itself
    assert.equal(iosRisk(MAP, null, dir), 'no earlier iOS pass');
    assert.match(iosRisk({ ...MAP, ios: undefined }, ['src/plain.tsx'], dir), /no "ios" rule/);
    assert.equal(iosRisk({ ...MAP, ios: undefined }, [], dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('describeDecision: one line per case, in Vietnamese and English, with a parseable code', () => {
  const none = { androidFlows: [], ios: { mode: 'none', flows: [] }, skipped: [], noChange: false };
  assert.equal(describeDecision('vi', none).text, 'app-qa: bỏ qua - chỉ test/tài liệu/map đổi');
  assert.equal(describeDecision('en', none).text, 'app-qa: skipped - only tests, docs or maps changed');
  assert.equal(describeDecision('vi', { ...none, noChange: true }).text, 'app-qa: bỏ qua - không có gì đổi từ lần đạt gần nhất');
  assert.match(describeDecision('vi', { ...none, skipped: ['src/lib/a.ts'] }).text, /logic thuần đã có unit test xanh \(src\/lib\/a\.ts\)/);
  const defer = { androidFlows: ['01-read', '04-resume'], ios: { mode: 'defer', flows: ['01-read', '04-resume'] }, skipped: [], noChange: false };
  const d = describeDecision('vi', defer);
  assert.equal(d.text, 'app-qa: Android 2 luồng (01-read, 04-resume); iOS để tới verify:land hoặc phát hành (không có thay đổi riêng iOS)');
  assert.equal(d.code, 'android=2 ios=deferred:2');
  assert.match(describeDecision('en', defer).text, /Android 2 flows \(01-read, 04-resume\); iOS waits for the land\/release step/);
  const run = { androidFlows: ['03-screens'], ios: { mode: 'run', flows: ['03-screens'], why: 'app.json' }, skipped: [], noChange: false };
  assert.equal(describeDecision('en', run).text, 'app-qa: Android 1 flow (03-screens); iOS 1 flow in the background (app.json)');
  assert.equal(describeDecision('en', run).code, 'android=1 ios=1');
  assert.match(describeDecision('vi', { ...none, ios: { mode: 'defer', flows: ['a'] } }).text, /iOS \(1 luồng\) để tới bước đẩy/);
  assert.match(describeDecision('xx', none).text, /skipped/); // unknown language falls back to English
});

test('iosRisk: an ignored file (docs, tests, the map) that mentions the patterns is not a risk; Vietnamese reasons', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-risk2-'));
  try {
    fs.mkdirSync(path.join(dir, '.maestro'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.maestro/flows-map.json'), '"content": "NativeTabs|GlassView"');
    fs.writeFileSync(path.join(dir, 'NOTES.md'), 'NativeTabs');
    const map = { ...MAP, ignore: [...MAP.ignore, '.maestro/flows-map.json'] };
    assert.equal(iosRisk(map, ['.maestro/flows-map.json', 'NOTES.md'], dir), null);
    assert.equal(iosRisk(map, null, dir, 'vi'), 'chưa có lần iOS nào đạt');
    fs.writeFileSync(path.join(dir, 'tabs.tsx'), 'NativeTabs');
    assert.equal(iosRisk(map, ['tabs.tsx'], dir, 'vi'), 'tabs.tsx (mã riêng iOS)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('describeDecision: a gate run (--ios wait) says it waits for the result', () => {
  const d = { androidFlows: [], ios: { mode: 'run', flows: ['03-screens'], why: 'land', wait: true }, skipped: [], noChange: false };
  assert.equal(describeDecision('en', d).text, 'app-qa: Android nothing to run; iOS 1 flow, waiting for the result (land)');
  assert.match(describeDecision('vi', d).text, /iOS 1 luồng, chờ kết quả \(land\)/);
});
