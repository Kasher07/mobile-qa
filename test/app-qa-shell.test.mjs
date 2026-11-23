import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { cacheDir, findShell, mediaHash, shellKey, storeShell } from '../bin/app-qa-shell.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aqs-'));
process.env.APP_QA_CACHE = path.join(tmp, 'cache');
const app = path.join(tmp, 'app');
fs.mkdirSync(path.join(app, 'assets'), { recursive: true });
fs.mkdirSync(path.join(app, 'src'), { recursive: true });
fs.writeFileSync(path.join(app, 'assets', 'icon.png'), 'png1');
fs.writeFileSync(path.join(app, 'src', 'a.tsx'), 'code1');
fs.writeFileSync(path.join(app, 'package.json'), '{}');
const files = ['assets/icon.png', 'src/a.tsx', 'package.json'];

test('the shell key ignores JS changes and follows media and native changes', () => {
  const m1 = mediaHash(app, files);
  fs.writeFileSync(path.join(app, 'src', 'a.tsx'), 'code2');
  assert.equal(mediaHash(app, files), m1, 'a JS edit keeps the key');
  fs.writeFileSync(path.join(app, 'package.json'), '{"x":1}');
  assert.equal(mediaHash(app, files), m1, 'package.json is the fingerprint\'s business, not media');
  fs.writeFileSync(path.join(app, 'assets', 'icon.png'), 'png2');
  assert.notEqual(mediaHash(app, files), m1, 'an image edit changes the key');
  assert.equal(shellKey(null, m1), null, 'no fingerprint, no reuse');
  assert.notEqual(shellKey('a'.repeat(40), m1), shellKey('b'.repeat(40), m1));
});

test('shells are kept per platform, newest two only', () => {
  for (const k of ['k1', 'k2', 'k3']) {
    const f = path.join(tmp, k + '.tgz');
    fs.writeFileSync(f, k);
    storeShell('vn.test.app', 'ios', k, f);
    assert.equal(fs.existsSync(f), false, 'the downloaded copy is moved');
    const now = Date.now() / 1000 - 100 + ['k1', 'k2', 'k3'].indexOf(k); // older than the next store
    fs.utimesSync(path.join(cacheDir('vn.test.app'), 'ios-' + k + '.tgz'), now, now);
  }
  const f4 = path.join(tmp, 'k4.tgz');
  fs.writeFileSync(f4, 'k4');
  storeShell('vn.test.app', 'ios', 'k4', f4);
  assert.equal(findShell('vn.test.app', 'ios', 'k1'), null);
  assert.ok(findShell('vn.test.app', 'ios', 'k4'));
  assert.equal(findShell('vn.test.app', 'android', 'k4'), null);
  assert.equal(findShell('vn.test.app', 'ios', null), null);
});
