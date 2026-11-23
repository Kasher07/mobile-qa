import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { codemagic, codemagicConfig, codemagicConfigs } from '../bin/app-qa-lib.mjs';
import { chooseIosLane, parseIosOn, pickLane, readClaims, usage, writeClaim } from '../bin/app-qa-pool.mjs';

const NOW = Date.parse('2026-11-23T12:30:00Z');
const min = (n) => new Date(NOW - n * 60000).toISOString();
// Shapes as returned by GET /builds?appId= (read from a real response 2026-11-23).
const done = (startAgoMin, lenMin, status = 'finished') => ({ status, createdAt: min(startAgoMin + 1), startedAt: min(startAgoMin), finishedAt: min(startAgoMin - lenMin) });
const queued = (agoMin) => ({ index: 11, status: 'queued', createdAt: min(agoMin), startedAt: null, finishedAt: null });
const acct = (index, o = {}) => ({ index, label: '#' + index, quota: 500, busy: false, running: null, minutes: 0, ...o });

test('usage: idle account with finished builds sums rounded-up minutes of this month only', () => {
  const lastMonth = { status: 'finished', createdAt: '2026-10-31T23:00:00Z', startedAt: '2026-10-31T23:10:00Z', finishedAt: '2026-10-31T23:50:00Z' };
  const straddle = { status: 'finished', createdAt: '2026-10-31T23:00:00Z', startedAt: '2026-10-31T23:50:00Z', finishedAt: '2026-11-01T00:10:30Z' };
  const u = usage([done(100, 22.4), done(300, 6), lastMonth, straddle, { status: 'canceled', createdAt: min(400), startedAt: null, finishedAt: null }], NOW);
  assert.deepEqual(u, { busy: false, running: null, minutes: 23 + 6 + 11 });
});

test('usage: a running build is busy and counts up to now; a queued one is busy and counts nothing', () => {
  const running = { index: 10, status: 'building', createdAt: min(40), startedAt: min(18.5), finishedAt: null };
  assert.deepEqual(usage([queued(2), running, done(200, 10)], NOW), { busy: true, running: { index: 11, status: 'queued' }, minutes: 19 + 10 });
  assert.equal(usage([queued(2)], NOW).minutes, 0);
  for (const status of ['initializing', 'waiting', 'preparing', 'fetching', 'testing', 'publishing', 'finishing', 'canceling']) assert.ok(usage([{ status, createdAt: min(5) }], NOW).busy, status);
  for (const status of ['finished', 'failed', 'canceled', 'timeout', 'skipped']) assert.ok(!usage([{ status, createdAt: min(5), startedAt: null }], NOW).busy, status);
});

test('usage: a not-final build older than 4 hours is a ghost, not a queue', () => {
  assert.equal(usage([{ status: 'queued', createdAt: min(5 * 60), startedAt: null, finishedAt: null }], NOW).busy, false);
  assert.equal(usage([], NOW).minutes, 0);
  assert.equal(usage(undefined, NOW).busy, false);
});

test('pickLane: the idle account with the most minutes left wins; ties go to the lower number', () => {
  assert.equal(pickLane([acct(1, { minutes: 120 }), acct(2, { minutes: 10 })]).account.index, 2);
  assert.equal(pickLane([acct(1, { minutes: 10 }), acct(2, { minutes: 120 })]).account.index, 1);
  assert.equal(pickLane([acct(1), acct(2)]).account.index, 1);
});

test('pickLane: a busy account is skipped; the other takes the run', () => {
  const r = pickLane([acct(1, { busy: true, running: { index: 10, status: 'building' } }), acct(2, { minutes: 300 })]);
  assert.equal(r.lane, 'codemagic');
  assert.equal(r.account.index, 2);
  assert.match(r.why, /#1 busy \(build 10 building\)/);
});

test('pickLane: every account busy, low or unreachable goes to GitHub shards with the reason', () => {
  const r = pickLane([acct(1, { busy: true, running: { index: 10, status: 'queued' } }), acct(2, { minutes: 470 })]);
  assert.equal(r.lane, 'github');
  assert.match(r.why, /instead of queueing: #1 busy, #2 only 30 min left/);
  assert.equal(pickLane([acct(1, { minutes: 456 })]).lane, 'github'); // 44 left < 45
  assert.equal(pickLane([acct(1, { minutes: 455 })]).lane, 'codemagic'); // exactly 45 left
  assert.match(pickLane([acct(1, { error: 'HTTP 500' }), acct(2, { error: 'x' })]).why, /#1 unreachable, #2 unreachable/);
  assert.deepEqual(pickLane([]), { lane: 'github', why: 'no Codemagic account configured' });
});

test('pickLane: an unreachable account is not used, the reachable one still is', () => {
  assert.equal(pickLane([acct(1, { error: 'HTTP 401' }), acct(2)]).account.index, 2);
});

test('pickLane: --ios-on forces a lane', () => {
  const busy = acct(1, { busy: true, running: { index: 3, status: 'building' } });
  assert.equal(pickLane([acct(1), acct(2)], { lane: 'github' }).lane, 'github');
  assert.equal(pickLane([busy, acct(2, { minutes: 499 })], { lane: 'codemagic', account: null }).account.index, 2); // idle beats minutes
  assert.equal(pickLane([busy, acct(2, { busy: true })], { lane: 'codemagic', account: null }).account.index, 1); // both busy: it queues on the one with minutes
  assert.equal(pickLane([acct(1), acct(2)], { lane: 'codemagic', account: 2 }).account.index, 2);
  assert.equal(pickLane([busy, acct(2)], { lane: 'codemagic', account: 1 }).account.index, 1); // forced even though busy
  assert.throws(() => pickLane([acct(1)], { lane: 'codemagic', account: 2 }), /not configured/);
  assert.throws(() => pickLane([], { lane: 'codemagic', account: null }), /needs a Codemagic token/);
});

test('parseIosOn', () => {
  assert.equal(parseIosOn(null), null);
  assert.deepEqual(parseIosOn('github'), { lane: 'github' });
  assert.deepEqual(parseIosOn('codemagic'), { lane: 'codemagic', account: null });
  assert.deepEqual(parseIosOn('codemagic:2'), { lane: 'codemagic', account: 2 });
  assert.throws(() => parseIosOn('codemagic:x'), /--ios-on/);
  assert.throws(() => parseIosOn('mac'), /--ios-on/);
});

// ---- the glue, with a fake API and a temp kit folder
const withKitDir = (fn) => async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-pool-'));
  const saved = { LOCALAPPDATA: process.env.LOCALAPPDATA, CODEMAGIC_TOKEN: process.env.CODEMAGIC_TOKEN };
  process.env.LOCALAPPDATA = dir;
  delete process.env.CODEMAGIC_TOKEN;
  const kit = path.join(dir, 'kit-app-qa');
  fs.mkdirSync(kit);
  try { await fn(kit); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
const put = (kit, n, appId, token = 'tok-' + n) => {
  const sfx = n === 1 ? '' : '-' + n;
  fs.writeFileSync(path.join(kit, 'codemagic' + sfx + '.token'), token + '\n');
  fs.writeFileSync(path.join(kit, 'codemagic' + sfx + '.json'), JSON.stringify({ appId, workflowId: 'app-qa-ios' }));
};

test('chooseIosLane: reads each account, skips the busy one, and a claim keeps a second call off it', withKitDir(async () => {
  const configs = [{ index: 1, label: '#1', token: 't1', appId: 'a1', workflowId: 'w' }, { index: 2, label: '#2', token: 't2', appId: 'a2', workflowId: 'w' }];
  const lists = { a1: [done(60, 20), queued(3)], a2: [done(90, 15)] };
  const api = (c) => ({ listBuilds: async () => lists[c.appId] });
  const logs = [];
  const r = await chooseIosLane({ configs, force: null, log: (s) => logs.push(s), now: NOW, api });
  assert.equal(r.conf.index, 2);
  assert.match(r.why, /#2 is idle with the most minutes left, 485/);
  writeClaim(2, 'aq-test', NOW);
  assert.equal(readClaims(NOW).length, 1);
  const again = await chooseIosLane({ configs, force: null, log: () => {}, now: NOW + 60000, api });
  assert.equal(again.lane, 'github');
  assert.match(again.why, /#1 busy, #2 busy/);
  assert.equal(readClaims(NOW + 4 * 60000).length, 0); // expired
}));

test('chooseIosLane: an API failure marks that account unreachable and the other one runs', withKitDir(async () => {
  const configs = [{ index: 1, label: '#1', appId: 'a1' }, { index: 2, label: '#2', appId: 'a2' }];
  const api = (c) => ({ listBuilds: async () => { if (c.index === 1) throw new Error('Codemagic GET /builds: HTTP 500'); return []; } });
  const r = await chooseIosLane({ configs, force: null, log: () => {}, now: NOW, api });
  assert.equal(r.conf.index, 2);
  assert.match(r.why, /#1 unreachable/);
}));

test('codemagicConfigs: account 1 and every codemagic-<n> pair, in order; incomplete pairs skipped', withKitDir(async (kit) => {
  put(kit, 1, 'app1');
  put(kit, 3, 'app3');
  put(kit, 2, 'app2');
  fs.writeFileSync(path.join(kit, 'codemagic-4.json'), JSON.stringify({ appId: 'app4' })); // no token
  fs.writeFileSync(path.join(kit, 'codemagic-5.token'), 'x'); // no json
  fs.writeFileSync(path.join(kit, 'codemagic-6.json'), '{broken'); // unreadable
  fs.writeFileSync(path.join(kit, 'codemagic-6.token'), 'x');
  const c = codemagicConfigs();
  assert.deepEqual(c.map((x) => [x.index, x.label, x.appId, x.workflowId]), [[1, '#1', 'app1', 'app-qa-ios'], [2, '#2', 'app2', 'app-qa-ios'], [3, '#3', 'app3', 'app-qa-ios']]);
  assert.equal(c[1].token, 'tok-2');
  assert.equal(codemagicConfig().appId, 'app1'); // the old single-account call
}));

test('codemagicConfigs: CODEMAGIC_TOKEN is a single-account override; nothing configured = none', withKitDir(async (kit) => {
  assert.deepEqual(codemagicConfigs(), []);
  assert.equal(codemagicConfig(), null);
  put(kit, 1, 'app1');
  put(kit, 2, 'app2');
  process.env.CODEMAGIC_TOKEN = 'from-env';
  const c = codemagicConfigs();
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].index, c[0].token, c[0].appId], [1, 'from-env', 'app1']);
}));

test('codemagic().listBuilds pages with limit/skip until a short page or an old build', async () => {
  const urls = [];
  const saved = globalThis.fetch;
  const mk = (n, createdAt) => Array.from({ length: n }, (_, i) => ({ index: i, createdAt }));
  const pages = [mk(2, '2026-11-20T00:00:00Z'), mk(2, '2026-10-20T00:00:00Z'), mk(2, '2026-09-20T00:00:00Z')];
  globalThis.fetch = async (url) => { urls.push(url); return { ok: true, json: async () => ({ builds: pages[urls.length - 1] }) }; };
  try {
    const all = await codemagic({ token: 't', appId: 'a b' }, () => {}).listBuilds({ sinceMs: Date.parse('2026-11-01T00:00:00Z'), limit: 2 });
    assert.equal(all.length, 4); // page 2 ends before the month: stop there
    assert.deepEqual(urls, ['https://api.codemagic.io/builds?appId=a%20b&limit=2&skip=0', 'https://api.codemagic.io/builds?appId=a%20b&limit=2&skip=2']);
  } finally { globalThis.fetch = saved; }
});

test('codemagic().wait: a 404 right after the start is retried quietly, then the build is followed', async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 404, text: async () => '{"error":"NOT_FOUND"}' };
    return { ok: true, json: async () => ({ build: { status: 'finished', buildActions: [{ name: 'Fetch and decrypt the app', status: 'success' }] } }) };
  };
  const logs = [];
  try {
    const b = await codemagic({ token: 't', appId: 'a' }, (s) => logs.push(s)).wait('id1', { notFoundRetryMs: 1 });
    assert.equal(b.status, 'finished');
    assert.ok(!logs.some((l) => /404/.test(l)), logs.join('\n'));
  } finally { globalThis.fetch = saved; }
});
