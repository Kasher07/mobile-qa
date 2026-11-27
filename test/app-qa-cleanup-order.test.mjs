import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lockHolder } from '../bin/app-qa-lib.mjs';

// The release of a call is the lock of the next one (sweepAndLock): APP_QA_KEY must be replaced before the release is
// deleted, or the next call's freshly set key is overwritten and its app cannot be decrypted (2026-11-27).
test('app-qa cleanup replaces APP_QA_KEY before it deletes the release (the lock)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'bin', 'app-qa.mjs'), 'utf8');
  const body = src.slice(src.indexOf('function cleanup()'));
  const key = body.indexOf("setKey(randomBytes(32).toString('hex'))");
  const rel = body.indexOf("gh(['release', 'delete', tag");
  assert.ok(key > 0 && rel > 0, 'both steps found in cleanup');
  assert.ok(key < rel, 'the key is replaced first');
});

test('lockHolder: the oldest live app-qa release holds the repo; background iOS and old releases do not count', () => {
  const now = Date.parse('2026-11-27T09:20:00Z');
  const r = (tagName, createdAt, name = tagName) => ({ tagName, createdAt, name });
  assert.equal(lockHolder([r('app-qa-b', '2026-11-27T09:19:46Z'), r('app-qa-a', '2026-11-27T09:19:37Z')], now), 'app-qa-a');
  assert.equal(lockHolder([r('app-qa-b', '2026-11-27T09:19:40Z'), r('app-qa-a', '2026-11-27T09:19:40Z')], now), 'app-qa-a'); // same second: tag order
  assert.equal(lockHolder([r('app-qa-a', '2026-11-27T09:10:00Z', 'app-qa-a ios-background'), r('app-qa-b', '2026-11-27T09:19:46Z')], now), 'app-qa-b');
  assert.equal(lockHolder([r('app-qa-old', '2026-11-27T05:00:00Z'), r('v1.0', '2026-11-27T09:00:00Z')], now), null);
  assert.equal(lockHolder([], now), null);
});

test('app-qa main takes the lock (release first) before it sets APP_QA_KEY', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'bin', 'app-qa.mjs'), 'utf8');
  const main = src.slice(src.indexOf('let code = 0;'));
  const lock = main.indexOf('await acquireLock(');
  const key = main.indexOf("setKey(key.toString('hex'))");
  assert.ok(lock > 0 && key > lock);
  assert.equal((src.match(/gh\(\['release', 'create'/g) || []).length, 1);
});
