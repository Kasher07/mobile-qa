import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A failed Maestro flow is a test result (junit.xml, read by summarize), not a broken run: the flow step must pass so
// GitHub sends no "workflow run failed" mail. Only a step without junit.xml (Maestro itself broke) fails.
const root = path.join(import.meta.dirname, '..');
const scripts = ['runner/app-ios.sh', 'runner/app-android.sh'];

for (const s of scripts) {
  test(s + ': ends every flow and widget branch through verdict, never a raw exit $status', () => {
    const src = fs.readFileSync(path.join(root, s), 'utf8');
    assert.ok(!/exit \$status/.test(src), 'raw exit $status left');
    assert.equal((src.match(/verdict \$status/g) || []).length, 2);
  });

  test(s + ': verdict exits 0 with junit.xml, keeps the code without it', () => {
    const line = fs.readFileSync(path.join(root, s), 'utf8').split('\n').find((l) => l.startsWith('verdict() '));
    assert.ok(line, 'verdict() missing');
    const run = (withJunit, status) => {
      const out = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-'));
      if (withJunit) fs.writeFileSync(path.join(out, 'junit.xml'), '<testsuites/>');
      const r = spawnSync('bash', ['-c', line + '\nverdict ' + status], { env: { ...process.env, OUT: out }, encoding: 'utf8' });
      fs.rmSync(out, { recursive: true, force: true });
      return r.status;
    };
    assert.equal(run(true, 1), 0);
    assert.equal(run(true, 0), 0);
    assert.equal(run(false, 1), 1);
    assert.equal(run(false, 0), 0);
  });
}
