import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';

import { widgetPlan, widgetPlatforms } from '../bin/app-qa-widgets.mjs';
import { galleryPages, iosAddFlow, iosLockFlow, iosShootFlow, iosTintFlow, junitXml, setupFlow } from '../runner/widgets-flows.mjs';

const EXPO = {
  name: 'PTH',
  plugins: [
    'expo-router',
    ['expo-widgets', {
      enableAndroid: true,
      widgets: [
        { name: 'PthPaper', displayName: 'Câu gốc · Trang giấy', ios: { supportedFamilies: ['systemLarge', 'systemSmall', 'systemMedium'] }, android: { targetCellWidth: 4 } },
        { name: 'PthReadToday', ios: { supportedFamilies: ['systemSmall', 'systemLarge'] }, android: null },
        { name: 'PthStreak', ios: null, android: { targetCellWidth: 2 } },
        { name: 'PthLock', displayName: 'Khoá', ios: { supportedFamilies: ['accessoryInline', 'accessoryRectangular', 'accessoryCircular'] }, android: null },
      ],
    }],
  ],
};

test('the plan reads expo-widgets: Android kinds, iOS home families in gallery order, lock families apart', () => {
  const p = widgetPlan(EXPO);
  assert.deepEqual(p.android, ['PthPaper', 'PthStreak']);
  assert.deepEqual(p.ios, [
    { name: 'PthPaper', label: 'Câu gốc · Trang giấy', families: ['systemSmall', 'systemMedium', 'systemLarge'] },
    { name: 'PthReadToday', label: 'PthReadToday', families: ['systemSmall', 'systemLarge'] },
  ]);
  assert.deepEqual(p.lock, [{ name: 'PthLock', label: 'Khoá', families: ['accessoryCircular', 'accessoryRectangular', 'accessoryInline'] }]);
  assert.equal(p.appName, 'PTH');
  assert.deepEqual(widgetPlatforms(p, ['ios', 'android']), ['ios', 'android']);
});

test('a name list keeps only those widgets; an unknown name or no widgets at all is an error', () => {
  const p = widgetPlan(EXPO, 'PthStreak');
  assert.deepEqual([p.android, p.ios, p.lock], [['PthStreak'], [], []]);
  assert.deepEqual(widgetPlatforms(p, ['ios', 'android']), ['android']);
  assert.throws(() => widgetPlan(EXPO, 'Nope'), /no widget named Nope/);
  assert.throws(() => widgetPlan({ plugins: ['expo-router'] }), /declares no widgets/);
  assert.throws(() => widgetPlan(EXPO, 'a b'), /comma-separated/);
});

test('Android widgets need enableAndroid', () => {
  const expo = structuredClone(EXPO);
  expo.plugins[1][1].enableAndroid = false;
  assert.deepEqual(widgetPlan(expo).android, []);
});

test('generated flows are valid Maestro YAML; the gallery page index follows kinds then families', () => {
  const plan = widgetPlan(EXPO);
  assert.deepEqual(galleryPages(plan).map((p) => p.name + ':' + p.family + ':' + p.index), [
    'PthPaper:systemSmall:0', 'PthPaper:systemMedium:1', 'PthPaper:systemLarge:2', 'PthReadToday:systemSmall:3', 'PthReadToday:systemLarge:4',
  ]);
  for (const y of [iosAddFlow(plan), iosShootFlow('ios-light', 3), iosTintFlow('Tinted', 2), iosTintFlow('Default', 0), iosLockFlow(plan), setupFlow('a.b', 'ios'), setupFlow('a.b', 'android')]) {
    const [head, body] = y.split('---\n');
    assert.ok(parse(head).appId);
    assert.ok(Array.isArray(parse(body)), y);
  }
  const add = parse(iosAddFlow(plan).split('---\n')[1]);
  // The 5th widget (index 4) is 4 swipes into the app's gallery.
  const lastAdd = add.map((c, i) => [c, i]).filter(([c]) => c.takeScreenshot === 'gallery-PthReadToday-systemLarge')[0][1];
  let swipes = 0;
  for (let i = lastAdd - 1; i >= 0 && !(add[i].tapOn === 'PTH'); i--) if (add[i].swipe) swipes++;
  assert.equal(swipes, 4);
  assert.equal(parse(iosShootFlow('x', 3).split('---\n')[1]).filter((c) => c.takeScreenshot).length, 3);
});

test('junit: failures count, skipped steps are not failures, text is escaped', () => {
  const x = junitXml('widgets-ios', [
    { name: 'a & b', ok: true },
    { name: 'lock', ok: false, skipped: true, msg: 'no "Add Widgets"' },
    { name: 'add', ok: false, msg: '<oops>' },
  ]);
  assert.match(x, /tests="3" failures="1"/);
  assert.match(x, /name="a &amp; b"/);
  assert.match(x, /<skipped message="no &quot;Add Widgets&quot;">/);
  assert.match(x, /<failure message="&lt;oops&gt;">/);
});
