// State handling of overlapping background iOS runs, unread results, the Codemagic wait loop and the pool lock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { accountForBuild, codemagic, codemagicConfigs, sleep } from '../bin/app-qa-lib.mjs';
import { markIosResultSeen, readUnseenIosResults, writeIosResult } from '../bin/app-qa-ios-results.mjs';
import { chooseIosLane, readClaims, withPoolLock } from '../bin/app-qa-pool.mjs';
import { changedSince, clearPendingIos, fileMapHash, moveLastPass, readLastPass, readPendingIos, readPendingIosAll, writeLastPass, writePendingIos } from '../bin/app-qa-select.mjs';

const APP = 'vn.test.app';
const B0 = { 'a.ts': '1', 'b.ts': '1' };
const S1 = { 'a.ts': '2', 'b.ts': '1' };
const S2 = { 'a.ts': '2', 'b.ts': '2' };

// A temp kit folder (LOCALAPPDATA) and cache (APP_QA_CACHE) for one test.
const withKit = (fn) => async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-state-'));
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, APP_QA_CACHE: process.env.APP_QA_CACHE, CODEMAGIC_TOKEN: process.env.CODEMAGIC_TOKEN };
  process.env.LOCALAPPDATA = dir;
  process.env.APP_QA_CACHE = path.join(dir, 'cache');
  delete process.env.CODEMAGIC_TOKEN;
  try { await fn(path.join(dir, 'kit-app-qa')); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('overlapping background runs: run 2 planned on run 1\'s content moves the pass only after run 1 passed', withKit(() => {
  writeLastPass(APP, 'ios', B0);
  // run 1 starts from the last pass B0, run 2 (started while run 1 is in flight) from run 1's pending content S1
  writePendingIos(APP, S1, 'r1');
  const base1 = fileMapHash(B0);
  assert.deepEqual(readPendingIos(APP), S1);
  writePendingIos(APP, S2, 'r2');
  const base2 = fileMapHash(readPendingIosAll(APP).find((p) => p.rid === 'r1').files);
  // run 1 FAILS, run 2 passes: the pass must stay at B0, so land still re-runs everything since B0
  assert.equal(moveLastPass(APP, 'ios', S2, base2), false);
  assert.deepEqual(readLastPass(APP, 'ios'), B0);
  assert.deepEqual(changedSince(readLastPass(APP, 'ios'), S2), ['a.ts', 'b.ts']);
}));

test('overlapping background runs: both pass in order = the pass follows; a late or older run cannot move it back', withKit(() => {
  writeLastPass(APP, 'ios', B0);
  const base1 = fileMapHash(B0);
  const base2 = fileMapHash(S1);
  assert.equal(moveLastPass(APP, 'ios', S1, base1), true);
  assert.equal(moveLastPass(APP, 'ios', S2, base2), true);
  assert.deepEqual(readLastPass(APP, 'ios'), S2);
  assert.equal(moveLastPass(APP, 'ios', S1, base1), false); // run 1 finishing again / another run with the old base
  assert.deepEqual(readLastPass(APP, 'ios'), S2);
  // run 2 finishing first (run 1 still going): not moved either; run 1 then moves to S1 and the next plan covers S1 -> S2
  writeLastPass(APP, 'ios', B0);
  assert.equal(moveLastPass(APP, 'ios', S2, base2), false);
  assert.equal(moveLastPass(APP, 'ios', S1, base1), true);
  assert.deepEqual(changedSince(readLastPass(APP, 'ios'), S2), ['b.ts']);
  // no pass yet: base "none"; a full run (base undefined) always moves
  fs.rmSync(process.env.APP_QA_CACHE, { recursive: true, force: true });
  assert.equal(moveLastPass(APP, 'ios', S1, fileMapHash(null)), true);
  assert.equal(moveLastPass(APP, 'ios', S2, undefined), true);
}));

test('pending state is kept per run id; the old single file is still read; old entries expire; each run clears its own', withKit(() => {
  writePendingIos(APP, S1, 'r1');
  writePendingIos(APP, S2, 'r2');
  assert.deepEqual(readPendingIosAll(APP).map((p) => p.rid).sort(), ['r1', 'r2']);
  clearPendingIos(APP, 'r2');
  assert.deepEqual(readPendingIosAll(APP).map((p) => p.rid), ['r1']);
  assert.equal(readPendingIosAll(APP, Date.now() + 91 * 60000).length, 0);
  const dir = path.join(process.env.APP_QA_CACHE, APP);
  fs.writeFileSync(path.join(dir, 'pending-ios.json'), JSON.stringify({ at: new Date().toISOString(), files: S2 }));
  assert.equal(readPendingIosAll(APP).length, 2);
  assert.deepEqual(readPendingIos(APP), S2); // newest first
  clearPendingIos(APP);
  assert.deepEqual(readPendingIosAll(APP).map((p) => p.rid), ['r1']);
}));

test('unread iOS results: every failure is kept and reported, none is overwritten by a later run, the old file is still read', withKit((kit) => {
  fs.mkdirSync(kit, { recursive: true });
  fs.writeFileSync(path.join(kit, 'last-ios-' + APP + '.json'), JSON.stringify({ at: '2026-11-23T10:00:00Z', ok: false, outDir: 'old', lines: [], seen: false }));
  writeIosResult(APP, 'r1', { at: '2026-11-23T11:00:00Z', ok: false, outDir: 'o1', lines: ['x'] });
  writeIosResult(APP, 'r2', { at: '2026-11-23T12:00:00Z', ok: true, outDir: 'o2', lines: [] });
  writeIosResult('vn.other.app', 'r9', { at: '2026-11-23T12:00:00Z', ok: false, outDir: 'o9', lines: [] });
  const unseen = readUnseenIosResults(APP);
  assert.deepEqual(unseen.map((e) => e.rec.outDir), ['old', 'o1', 'o2']); // oldest first, other apps excluded
  for (const e of unseen) markIosResultSeen(e);
  assert.deepEqual(readUnseenIosResults(APP), []);
  assert.equal(readUnseenIosResults('vn.other.app').length, 1);
  const legacy = JSON.parse(fs.readFileSync(path.join(kit, 'last-ios-' + APP + '.json'), 'utf8'));
  assert.equal(legacy.seen, true);
}));

test('accountForBuild: the recorded account, never a silent fallback; old state files mean the first account', () => {
  const confs = [{ index: 1, appId: 'a1' }, { index: 2, appId: 'a2' }];
  assert.equal(accountForBuild(confs, { buildId: 'b', cmAppId: 'a2', cmAccount: 2 }).index, 2);
  assert.equal(accountForBuild(confs, { buildId: 'b', cmAccount: 2 }).index, 2);
  assert.equal(accountForBuild(confs, { buildId: 'b' }).index, 1);
  assert.throws(() => accountForBuild(confs, { buildId: 'b9', cmAppId: 'gone', cmAccount: 3 }), /not configured on this machine: build b9/);
  assert.throws(() => accountForBuild([confs[1]], { buildId: 'b', cmAccount: 1 }), /not configured/);
  assert.throws(() => accountForBuild([], { buildId: 'b' }), /not configured/);
});

// ---- the wait loop
const notFound = { ok: false, status: 404, text: async () => '{"error":"NOT_FOUND"}' };
const done = { ok: true, json: async () => ({ build: { status: 'finished', buildActions: [] } }) };
const withFetch = async (responses, fn) => {
  const saved = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async () => { const r = responses[Math.min(i++, responses.length - 1)]; if (r instanceof Error) throw r; return r; };
  try { return await fn(() => i); } finally { globalThis.fetch = saved; }
};
const fast = { notFoundRetryMs: 1, errorRetryMs: 1, pollMs: 1 };

test('wait: two consecutive 404s inside the start-up window are retried quietly', async () => {
  const logs = [];
  await withFetch([notFound, notFound, done], async (calls) => {
    const b = await codemagic({ token: 't', appId: 'a' }, (s) => logs.push(s)).wait('id', { ...fast, notFoundWindowMs: 60000 });
    assert.equal(b.status, 'finished');
    assert.equal(calls(), 3);
  });
  assert.ok(!logs.some((l) => /404|NOT_FOUND/.test(l)), logs.join('\n'));
});

test('wait: a 404 after the window, a 404 after a good read, 401 and 403 end it at once with an error', async () => {
  await withFetch([notFound], async () => {
    await assert.rejects(codemagic({ token: 't', appId: 'a' }, () => {}).wait('id', { ...fast, notFoundWindowMs: 0 }), /HTTP 404/);
  });
  const running = { ok: true, json: async () => ({ build: { status: 'building', buildActions: [] } }) };
  await withFetch([running, notFound], async () => {
    await assert.rejects(codemagic({ token: 't', appId: 'a' }, () => {}).wait('id', { ...fast, notFoundWindowMs: 60000 }), /HTTP 404/);
  });
  for (const status of [401, 403]) {
    await withFetch([{ ok: false, status, text: async () => 'no' }], async (calls) => {
      await assert.rejects(codemagic({ token: 't', appId: 'a' }, () => {}).wait('id', fast), new RegExp('HTTP ' + status));
      assert.equal(calls(), 1);
    });
  }
});

test('wait: a network outage ends at the deadline with an error (the deadline is checked after errors too), logged sparingly', async () => {
  const logs = [];
  await withFetch([new TypeError('fetch failed')], async (calls) => {
    await assert.rejects(codemagic({ token: 't', appId: 'a' }, (s) => logs.push(s)).wait('id', { ...fast, deadlineMs: 60 }), /timed out after .* \(last status: never read\)/);
    assert.ok(calls() > 3);
  });
  assert.ok(logs.length < 6, logs.length + ' log lines');
  // 5xx the same
  await withFetch([{ ok: false, status: 503, text: async () => 'busy' }], async () => {
    await assert.rejects(codemagic({ token: 't', appId: 'a' }, () => {}).wait('id', { ...fast, deadlineMs: 40 }), /timed out/);
  });
});

// ---- the pool lock and claims
const two = [{ index: 1, label: '#1', appId: 'a1' }, { index: 2, label: '#2', appId: 'a2' }];
const NOW = Date.parse('2026-11-23T12:30:00Z');
const slowIdle = () => ({ listBuilds: async () => { await sleep(40); return []; } });

test('two picks at the same moment get different accounts (pick and claim are atomic); a third goes to GitHub', withKit(async () => {
  const run = (rid) => chooseIosLane({ configs: two, force: null, log: () => {}, rid, now: NOW, api: slowIdle, lock: { pollMs: 5 } });
  const [a, b] = await Promise.all([run('r1'), run('r2')]);
  assert.deepEqual([a.conf.index, b.conf.index].sort(), [1, 2]);
  assert.equal(readClaims(NOW).length, 2);
  const c = await run('r3');
  assert.equal(c.lane, 'github');
  assert.ok(!fs.existsSync(path.join(process.env.LOCALAPPDATA, 'kit-app-qa', 'pool.lock')), 'lock released');
}));

test('the pool lock: exclusive, released when fn throws, a stale one is taken over, an unwritable wait degrades to unlocked', withKit(async (kit) => {
  const order = [];
  await Promise.all([1, 2, 3].map((n) => withPoolLock(async () => { order.push('in' + n); await sleep(15); order.push('out' + n); }, { pollMs: 2 })));
  for (let i = 0; i < order.length; i += 2) assert.equal(order[i].slice(2), order[i + 1].slice(3), order.join(','));
  await assert.rejects(withPoolLock(async () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(path.join(kit, 'pool.lock')));
  fs.mkdirSync(kit, { recursive: true });
  fs.writeFileSync(path.join(kit, 'pool.lock'), '');
  const old = new Date(Date.now() - 10 * 60000);
  fs.utimesSync(path.join(kit, 'pool.lock'), old, old);
  assert.equal(await withPoolLock(async () => 'ran', { staleMs: 120000 }), 'ran'); // dead owner's lock removed
  fs.writeFileSync(path.join(kit, 'pool.lock'), '');
  assert.equal(await withPoolLock(async () => 'unlocked', { waitMs: 30, pollMs: 5 }), 'unlocked'); // never blocks the run for good
  assert.ok(fs.existsSync(path.join(kit, 'pool.lock')), 'a lock we did not take is left alone');
}));

test('monthlyMinutes of an account is copied by the config loader and sets that account\'s quota', withKit(async (kit) => {
  fs.mkdirSync(kit, { recursive: true });
  fs.writeFileSync(path.join(kit, 'codemagic.token'), 't1');
  fs.writeFileSync(path.join(kit, 'codemagic.json'), JSON.stringify({ appId: 'a1', monthlyMinutes: 100 }));
  fs.writeFileSync(path.join(kit, 'codemagic-2.token'), 't2');
  fs.writeFileSync(path.join(kit, 'codemagic-2.json'), JSON.stringify({ appId: 'a2', monthlyMinutes: 'x' }));
  const configs = codemagicConfigs();
  assert.equal(configs[0].monthlyMinutes, 100);
  assert.equal(configs[1].monthlyMinutes, undefined);
  const used = (n) => [{ status: 'finished', createdAt: '2026-11-23T10:00:00Z', startedAt: '2026-11-23T10:00:00Z', finishedAt: new Date(Date.parse('2026-11-23T10:00:00Z') + n * 60000).toISOString() }];
  const api = (c) => ({ listBuilds: async () => (c.index === 1 ? used(60) : []) });
  const r = await chooseIosLane({ configs, force: null, log: () => {}, now: NOW, api });
  assert.equal(r.conf.index, 2); // #1 has 100 - 60 = 40 left, under 45
  const only = await chooseIosLane({ configs: [configs[0]], force: null, log: () => {}, now: NOW, api });
  assert.equal(only.lane, 'github');
}));
