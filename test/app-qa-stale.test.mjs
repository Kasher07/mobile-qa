import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearStaleResults, summarize } from '../bin/app-qa-lib.mjs';

const JUNIT_FAIL = '<testsuite><testcase name="Home"><failure>Assertion is false: "Trang chu" is visible</failure></testcase></testsuite>';
const put = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

test('results of an earlier run in --out are never read as this run\'s results', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'app-qa-stale-'));
  try {
    // What the earlier run left (PTH 2026-11-25: the next run's Android build failed, its flow jobs never ran).
    put(out, 'android-light-01-doc/junit.xml', JUNIT_FAIL);
    put(out, 'android-light-01-doc/checks.txt', 'apk_bytes=1');
    put(out, 'android/gradle.log', 'old');
    put(out, 'ios-dark-03-man-hinh/junit.xml', JUNIT_FAIL);
    put(out, 'app-android/x.enc', 'sealed');
    put(out, 'timings.txt', 'old');
    put(out, 'failed.log', 'old');
    put(out, 'notes-of-the-owner.txt', 'keep me');
    put(out, 'my-android-notes/a.txt', 'keep me too');
    const shards = [{ flow: '01-doc', pass: 'light' }];
    const lines = [];
    // Without the cleanup the stale failure is read as a verdict: this is the defect.
    assert.equal(summarize({ outDir: out, platform: 'android', shards, log: (l) => lines.push(l) }), false);
    assert.ok(lines.some((l) => /FAIL Home/.test(l)), 'the stale FAIL is visible before the cleanup');

    const removed = clearStaleResults(out);
    assert.deepEqual(removed.sort(), ['android', 'android-light-01-doc', 'app-android', 'failed.log', 'ios-dark-03-man-hinh', 'timings.txt']);
    const after = [];
    assert.equal(summarize({ outDir: out, platform: 'android', shards, log: (l) => after.push(l) }), false);
    assert.deepEqual(after, ['android/light 01-doc: no results']);
    assert.equal(fs.readFileSync(path.join(out, 'notes-of-the-owner.txt'), 'utf8'), 'keep me');
    assert.ok(fs.existsSync(path.join(out, 'my-android-notes/a.txt')));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('clearStaleResults on a missing folder removes nothing', () => {
  assert.deepEqual(clearStaleResults(path.join(os.tmpdir(), 'app-qa-no-such-folder-' + process.pid)), []);
});
