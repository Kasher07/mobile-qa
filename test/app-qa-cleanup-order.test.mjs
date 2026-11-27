import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
