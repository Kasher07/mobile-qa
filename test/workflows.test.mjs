import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse } from 'yaml';

// A workflow that does not parse breaks every call (GitHub answers 422): check before any push.
for (const f of fs.readdirSync(new URL('../.github/workflows/', import.meta.url))) {
  test('workflow parses: ' + f, () => {
    const wf = parse(fs.readFileSync(new URL('../.github/workflows/' + f, import.meta.url), 'utf8'));
    assert.ok(wf && wf.jobs, 'no jobs in ' + f);
    for (const [name, job] of Object.entries(wf.jobs)) {
      for (const s of job.steps || []) for (const u of [s.uses].filter(Boolean)) {
        if (!u.startsWith('./')) assert.match(u, /@[0-9a-f]{40}$/, f + ' ' + name + ': ' + u + ' is not pinned to a commit SHA');
      }
    }
  });
}

test('mobile-qa.yml keeps its dispatch inputs', () => {
  const wf = parse(fs.readFileSync(new URL('../.github/workflows/mobile-qa.yml', import.meta.url), 'utf8'));
  const inputs = wf.on.workflow_dispatch.inputs;
  for (const k of ['urls', 'platforms', 'request_id', 'max_segments', 'ios_device', 'ios_runner', 'ios_mode', 'test_fault']) assert.ok(inputs[k], 'missing input ' + k);
  assert.ok(Object.keys(inputs).length <= 10, 'GitHub allows at most 10 dispatch inputs');
});
