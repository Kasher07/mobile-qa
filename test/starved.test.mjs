import test from 'node:test';
import assert from 'node:assert/strict';
import { starvedAction } from '../bin/mobile-qa.mjs';

const job = (name, conclusion, ran = true) => ({ name, conclusion, runner_name: ran ? 'GitHub Actions 1' : '', steps: ran ? [{ name: 'x' }] : [] });

test('iOS never started on the first pool moves to the next pool', () => {
  assert.deepEqual(starvedAction([job('ios', 'cancelled', false), job('android', 'success')], 0, 2), { action: 'move', redo: 'ios' });
});
test('on the last pool a starved job is re-run in place', () => {
  assert.equal(starvedAction([job('ios', 'cancelled', false)], 1, 2).action, 'rerun');
});
test('a starved Android job is re-run, not moved', () => {
  assert.deepEqual(starvedAction([job('android', 'failure', false), job('ios', 'success')], 0, 2), { action: 'rerun', redo: 'android' });
});
test('a real failure is never retried', () => {
  assert.equal(starvedAction([job('ios', 'failure', true)], 0, 2).action, 'none');
  assert.equal(starvedAction([job('ios', 'cancelled', false), job('android', 'failure', true)], 0, 2).action, 'none');
});
test('nothing failed: nothing to do', () => assert.equal(starvedAction([job('ios', 'success'), job('android', 'skipped', false)], 0, 2).action, 'none'));
