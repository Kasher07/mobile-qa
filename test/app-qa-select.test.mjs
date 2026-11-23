import assert from 'node:assert/strict';
import { test } from 'node:test';

import { changedSince, globToRegExp, selectFlows } from '../bin/app-qa-select.mjs';

const FLOWS = ['01-read', '02-translation', '03-screens', '04-resume'];
const MAP = {
  ignore: ['**/*.md', '**/*.test.ts', 'src/**/*.web.{ts,tsx}'],
  all: ['app.json', 'package.json', 'src/app/_layout.tsx'],
  rules: [
    { paths: ['src/app/(tabs)/kinh-thanh.tsx', 'src/lib/bible/reading-spot.ts'], flows: ['01-read', '04-resume'] },
    { paths: ['src/lib/bible/store.ts'], flows: ['02-translation'] },
  ],
  dark: { paths: ['src/app/**'], flows: ['03-screens'] },
};

test('globs: ** any depth, * one segment, {a,b}, literal parentheses', () => {
  assert.ok(globToRegExp('src/**/*.test.ts').test('src/lib/bible/x.test.ts'));
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/b.ts'));
  assert.ok(globToRegExp('src/**/*.web.{ts,tsx}').test('src/lib/kv-store.web.ts'));
  assert.ok(globToRegExp('src/app/(tabs)/kinh-thanh.tsx').test('src/app/(tabs)/kinh-thanh.tsx'));
});

test('only the flows of the changed files run; dark pass only for screen files', () => {
  assert.deepEqual(selectFlows(MAP, ['src/lib/bible/reading-spot.ts'], FLOWS, ['03-screens']), { light: ['01-read', '04-resume'], dark: [], why: 'src/lib/bible/reading-spot.ts' });
  const r = selectFlows(MAP, ['src/app/(tabs)/kinh-thanh.tsx'], FLOWS);
  assert.deepEqual([r.light, r.dark], [['01-read', '04-resume'], ['03-screens']]);
  assert.deepEqual(selectFlows(MAP, ['.maestro/02-translation.yaml'], FLOWS).light, ['02-translation']);
});

test('docs, unit tests and web-only files need no QA; unknown or global files need every flow', () => {
  assert.deepEqual(selectFlows(MAP, ['README.md', 'src/lib/bible/bible.test.ts', 'src/lib/kv-store.web.ts'], FLOWS).light, []);
  assert.deepEqual(selectFlows(MAP, ['src/lib/new-thing.ts'], FLOWS).light, FLOWS);
  assert.deepEqual(selectFlows(MAP, ['app.json'], FLOWS).dark, ['03-screens']);
  assert.deepEqual(selectFlows(MAP, null, FLOWS, ['03-screens']).light, FLOWS, 'first run on a machine: everything');
  assert.deepEqual(selectFlows(null, ['src/x.ts'], FLOWS).light, FLOWS, 'no map: everything');
});

test('changed files: added, edited and deleted', () => {
  assert.deepEqual(changedSince({ a: '1', b: '2', c: '3' }, { a: '1', b: '9', d: '4' }), ['b', 'c', 'd']);
  assert.equal(changedSince(null, { a: '1' }), null);
});
