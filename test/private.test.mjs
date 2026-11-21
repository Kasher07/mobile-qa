import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { sealJob, openJob, seal, unseal, resultAad, checkPrivateTarget, cookiesFor, buildJob, allowedLine, sealDir, toWebDriverCookies, toPlaywrightCookies, validateJob, loadPrivateJob, takeSecrets, cookieTargetOk, isBlockedWrite, untrusted, leakVerdict, sameHost, rawArtifactLeaks, maskCommand } from '../runner/private.mjs';
import { leakScan, acquireLock, makeCleaner, listPrivateRuns } from '../bin/private-qa.mjs';
import { settleProbe } from '../runner/lib.mjs';
import { waitSettled } from '../runner/lib.mjs';
import { checkUrl, parseArgs } from '../bin/mobile-qa.mjs';
import { readUrls } from '../runner/lib.mjs';

const KEY = 'ab'.repeat(32);
const HOST = 'admin.example-shop.test';
const BASE = 'https://' + HOST;
const COOKIE = 'S3SS10N-v4lue-0123456789';
const state = { cookies: [
  { name: '__Host-session', value: COOKIE, domain: HOST, path: '/', expires: Math.floor(Date.now() / 1000) + 7000, httpOnly: true, secure: true, sameSite: 'Strict' },
  { name: 'other', value: 'NOT-FOR-THIS-HOST-123', domain: 'evil.test', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' },
  { name: 'old', value: 'EXPIRED-VALUE-12345', domain: HOST, path: '/', expires: 5, httpOnly: false, secure: true, sameSite: 'Lax' },
] };
const mkJob = () => buildJob({ KITQA_BASE: BASE, KITQA_STORAGE_STATE: 'x' }, ['/#sales', '/#inventory'], () => state).job;

test('job seal/unseal round trip, bound to the run id, tamper-proof, host not readable', () => {
  const job = mkJob();
  const b64 = sealJob(job, KEY, 'pq-1');
  assert.ok(!Buffer.from(b64, 'base64').toString('latin1').includes(HOST));
  assert.ok(!b64.includes(COOKIE));
  const back = openJob(b64, KEY, 'pq-1');
  assert.equal(back.base, BASE);
  assert.deepEqual(back.urls, [BASE + '/#sales', BASE + '/#inventory']);
  assert.equal(back.cookies.length, 1);
  assert.equal(back.cookies[0].value, COOKIE);
  assert.throws(() => openJob(b64, KEY, 'pq-2'), /auth|unable/i, 'another run id must not open it');
  assert.throws(() => openJob(b64, 'cd'.repeat(32), 'pq-1'));
  const buf = Buffer.from(b64, 'base64');
  buf[buf.length - 1] ^= 1;
  assert.throws(() => openJob(buf.toString('base64'), KEY, 'pq-1'));
  assert.throws(() => seal(Buffer.from('x'), 'short', 'a'), /key/);
});

test('results folder seals to ciphertext only and opens with the right key and platform', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-priv-'));
  const cwd = process.cwd();
  try {
    const dir = path.join(tmp, 'out', 'android');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ url: BASE + '/#sales' }));
    process.chdir(tmp);
    sealDir(dir, 'pq-9', 'android', KEY);
    const enc = fs.readFileSync(path.join(tmp, 'sealed', 'android', 'android.enc'));
    assert.ok(!enc.toString('latin1').includes(HOST));
    const tgz = unseal(enc, KEY, resultAad('pq-9', 'android'));
    assert.equal(tgz.subarray(0, 2).toString('hex'), '1f8b');
    assert.throws(() => unseal(enc, KEY, resultAad('pq-9', 'ios')));
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'sealed')), ['android']);
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('origin and path guard', () => {
  assert.deepEqual(checkPrivateTarget(BASE, ['/#sales', '/admin?x=1', BASE + '/#inventory']).paths, ['/#sales', '/admin?x=1', '/#inventory']);
  const no = (paths, re) => assert.throws(() => checkPrivateTarget(BASE, paths), re || /refused|only paths/);
  no(['https://evil.test/#sales']);
  no(['//evil.test/x']);
  no(['/\\evil.test/x']);
  no(['evil.test/x']);
  no(['https://user:pw@' + HOST + '/x']);
  no([BASE + '@evil.test/x']);
  no(['/a b']);
  no(['/a,b']);
  no(['/a\nb']);
  no(['#sales']);
  no([], /no paths/);
  for (const b of ['http://' + HOST, 'https://localhost', 'https://127.0.0.1', 'https://u:p@' + HOST, 'not a url', 'https://intranet']) {
    assert.throws(() => checkPrivateTarget(b, ['/x']), /./, b);
  }
  assert.throws(() => checkPrivateTarget(BASE, Array.from({ length: 13 }, (_, i) => '/p' + i)), /max 12/);
});

test('only this host cookies, none expired; token sites and missing session refused', () => {
  const c = cookiesFor(state, HOST);
  assert.deepEqual(c.map((x) => x.name), ['__Host-session']);
  assert.equal(c[0].hostOnly, true);
  assert.deepEqual(cookiesFor({ cookies: [{ name: 'a', value: 'v'.repeat(10), domain: '.example-shop.test', path: '/', expires: -1 }] }, HOST).length, 1);
  assert.throws(() => buildJob({ KITQA_BASE: BASE, KITQA_STORAGE_STATE: 'x' }, ['/x'], () => ({ cookies: [] })), /no usable session/);
  assert.throws(() => buildJob({ KITQA_URL: BASE + '/?token=1', KITQA_TOKEN: 't' }, ['/x']), /token sites/);
  assert.throws(() => buildJob({}, ['/x']), /runs under kit-qa/);
  const j = mkJob();
  assert.ok(Object.keys(j).every((k) => ['v', 'base', 'paths', 'cookies'].includes(k)));
  assert.throws(() => validateJob({ ...j, paths: ['https://evil.test/x'] }), /refused/);
  // HttpOnly, Secure and __Host- cookies keep their flags and get no domain
  const pw = toPlaywrightCookies(validateJob(j))[0];
  assert.deepEqual([pw.httpOnly, pw.secure, pw.sameSite, pw.url, 'domain' in pw], [true, true, 'Strict', BASE + '/', false]);
  const wd = toWebDriverCookies(validateJob(j))[0];
  assert.deepEqual([wd.httpOnly, wd.secure, wd.sameSite, 'domain' in wd, typeof wd.expiry], [true, true, 'Strict', false, 'number']);
});

test('private log allows page numbers only', () => {
  for (const s of ['[1/2] ', '      3s screen 2', '    ok in 14 s, 3 screens', '    error in 9 s, 1 screens', 'device Pixel 7 / Android 15 | Chrome 140', 'ios | iPhone 16 / iOS 18.5 | Safari (iOS 18.5) | mode=webdriver', '[private] cookies set: 1']) assert.ok(allowedLine(s), s);
  for (const s of [BASE + '/#sales', '[1/2] ' + BASE, '    error: net::ERR at ' + BASE, '- ' + BASE + ' :: ok overflowX=false shots=3', 'console: ' + COOKIE, 'window over Chrome: x']) assert.ok(!allowedLine(s), s);
});

test('a private runner prints no URL, host, cookie, console or page text (also on a crash)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-priv-log-'));
  try {
    const script = path.join(dir, 'fake-runner.mjs');
    const lib = new URL('../runner/private.mjs', import.meta.url).href;
    fs.writeFileSync(script, [
      "import { loadPrivateJob, installPrivateLogging } from '" + lib + "';",
      'const PRIV = loadPrivateJob();',
      "installPrivateLogging(PRIV, process.env, 'android');",
      "console.log('[1/2] ' + PRIV.urls[0]);",
      "console.log('[2/2] ');",
      "console.log('[private] cookies set: ' + PRIV.cookies.length);",
      "console.log('    error: net::ERR_X at ' + PRIV.urls[0] + ' ' + PRIV.cookies[0].value);",
      "console.error('Cookie: ' + PRIV.cookies[0].value);",
      "console.log('page text Dashboard Revenue');",
      "console.log('    ok in 3 s, 2 screens');",
      "throw new Error('boom ' + PRIV.urls[0] + ' ' + PRIV.cookies[0].value);",
    ].join('\n'));
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, PRIVATE_JOB: sealJob(mkJob(), KEY, 'pq-3'), PRIVATE_RID: 'pq-3', PRIVATE_QA_KEY: KEY } });
    const all = r.stdout + r.stderr;
    assert.equal(r.status, 1);
    for (const secret of [HOST, COOKIE, 'Dashboard', 'Revenue', 'boom', 'ERR_X', KEY, '#sales']) {
      const shown = all.split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');
      assert.ok(!shown.includes(secret), 'leaked ' + secret + ' in: ' + shown);
    }
    assert.match(all, /\[2\/2\]/);
    assert.ok(!/\[1\/2\]/.test(all), 'a line carrying a URL is dropped whole');
    assert.match(all, /ok in 3 s, 2 screens/);
    assert.match(all, /fatal error, details are sealed/);
    assert.match(all, /::add-mask::S3SS10N/);
    assert.ok(fs.existsSync(path.join(dir, 'out', 'android', 'fatal.txt')), 'the crash detail goes into out/<platform>, the folder that is sealed');
    assert.ok(!fs.existsSync(path.join(dir, 'out', 'fatal.txt')), 'and never next to it, where nothing seals it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('leak scan finds hostnames, cookies and URL-encoded forms', () => {
  assert.deepEqual(leakScan('a ' + HOST + ' b', { host: [HOST], cookie: [COOKIE] }), { host: 1, cookie: 0 });
  assert.equal(leakScan('x=' + encodeURIComponent('a b/c=d-longvalue'), { cookie: ['a b/c=d-longvalue'] }).cookie, 1);
  assert.equal(leakScan('clean log', { host: [HOST], cookie: [COOKIE] }).host, 0);
});

test('public mode is unchanged', () => {
  const o = parseArgs(['https://a.com/x', '--platforms', 'ios']);
  assert.deepEqual([o.private, o.platforms, o.urls], [false, 'ios', ['https://a.com/x']]);
  assert.equal(parseArgs(['--private', '/#sales']).private, true);
  assert.throws(() => parseArgs(['--private', '--keep', '/x']), /--private/);
  assert.ok(checkUrl('https://a.com/pricing').href);
  assert.ok(checkUrl('https://a.com/?token=1').why, 'public mode still refuses secrets');
  const saved = process.env.URLS;
  process.env.URLS = 'https://a.com/x';
  assert.deepEqual(readUrls(), ['https://a.com/x']);
  process.env.URLS = saved;
  const cli = (args, env) => spawnSync(process.execPath, [new URL('../bin/mobile-qa.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const r = cli(['--private', '/#sales'], {});
  assert.equal(r.status, 2);
  assert.match(r.stdout, /runs under kit-qa/);
  const t = cli(['--private', '/#sales'], { KITQA_URL: 'https://a.com/?token=1', KITQA_TOKEN: 'x' });
  assert.match(t.stdout, /token sites/);
});

const PRIV_IF = new Set(["inputs.private_job != ''", "always() && inputs.private_job != ''", "inputs.private_job != '' && steps.emu1p.outcome == 'failure'"]);
const PUB_IF = new Set(["inputs.private_job == ''", "inputs.private_job == '' && steps.emu1.outcome == 'failure'"]);
test('workflow: the secret reaches only private steps, never job or workflow env; public steps cannot see it', () => {
  const wf = parse(fs.readFileSync(new URL('../.github/workflows/mobile-qa.yml', import.meta.url), 'utf8'));
  assert.equal(wf.permissions.contents, 'read');
  assert.deepEqual(Object.keys(wf.permissions), ['contents']);
  assert.ok(!JSON.stringify(wf.env).includes('secrets.'), 'no secret in workflow env');
  assert.ok(wf.on.workflow_dispatch.inputs.private_job, 'private_job input');
  let guarded = 0;
  for (const [name, job] of Object.entries(wf.jobs)) {
    assert.ok(!JSON.stringify(job.env || {}).includes('secrets.'), name + ': no secret in job env');
    for (const s of job.steps) {
      const uses = JSON.stringify(s.env || {}).includes('secrets.PRIVATE_QA_KEY');
      const other = JSON.stringify({ ...s, env: undefined }).includes('secrets.');
      assert.ok(!other, name + ': secret outside step env: ' + (s.name || s.uses));
      if (uses) {
        guarded++;
        assert.ok(PRIV_IF.has(s.if), name + ': ' + s.name + ' has an unexpected if: ' + s.if);
      }
      if (/runner\/(ios|android)\.mjs/.test(JSON.stringify(s)) && !uses) assert.ok(PUB_IF.has(s.if), name + ': a public runner step must be skipped in private runs, got: ' + s.if);
      if (/actions\/cache\/(restore|save)/.test(s.uses || '')) assert.ok(/^inputs\.private_job == ''/.test(s.if || ''), name + ': private runs must not use the AVD cache');
      if (s.uses && s.uses.startsWith('actions/upload-artifact')) {
        const isPriv = PRIV_IF.has(s.if);
        assert.equal(s.with.path.startsWith('sealed/'), isPriv, name + ': private runs upload only sealed/, public ones only out/');
      }
    }
  }
  assert.ok(guarded >= 5, 'expected the private runner, seal and emulator steps, got ' + guarded);
});

test('item 1: iOS cookies only go to the job origin', () => {
  assert.equal(cookieTargetOk(BASE + '/robots.txt', BASE), true);
  assert.equal(cookieTargetOk('https://login.other.test/x', BASE), false);
  assert.equal(cookieTargetOk('http://' + HOST + '/robots.txt', BASE), false);
  assert.equal(cookieTargetOk('https://' + HOST + '.evil.test/', BASE), false);
  assert.equal(cookieTargetOk('about:blank', BASE), false);
  assert.equal(cookieTargetOk(undefined, BASE), false);
});

test('item 2: same-origin writes are blocked, reads and cross-origin pass', () => {
  assert.equal(isBlockedWrite('POST', BASE + '/api/x', BASE), true);
  assert.equal(isBlockedWrite('delete', BASE + '/api/x?a=1', BASE), true);
  assert.equal(isBlockedWrite('GET', BASE + '/api/x', BASE), false);
  assert.equal(isBlockedWrite('OPTIONS', BASE + '/api/x', BASE), false);
  assert.equal(isBlockedWrite('POST', 'https://analytics.other.test/c', BASE), false);
  assert.equal(isBlockedWrite('POST', BASE + '.evil.test/x', BASE), false);
  assert.equal(isBlockedWrite('PUT', 'not a url', BASE), false);
});

test('item 2: the android runner installs its guards fail-closed (source check)', () => {
  const src = fs.readFileSync(new URL('../runner/android.mjs', import.meta.url), 'utf8');
  assert.match(src, /serviceWorkers: 'block'/);
  assert.match(src, /await ctx\.route\('\*\*\/\*'/, 'one awaited context-level route');
  assert.match(src, /routeWebSocket/);
  assert.match(src, /if \(guardError\) throw new Error\(guardError\)/, 'no page loads without the guard');
  assert.match(src, /d\.type\(\) !== 'beforeunload'/);
  assert.ok(!/p\.route\(/.test(src), 'no per-page route: the context-level one covers every tab');
});

test('item 3: lock file is exclusive, stale locks of dead pids are taken over', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mq-lock-')), 'l.lock');
  const rel = acquireLock(f, { pid: 111, alive: () => true });
  assert.throws(() => acquireLock(f, { pid: 222, alive: () => true }), /another private call/);
  rel();
  assert.ok(!fs.existsSync(f));
  fs.writeFileSync(f, JSON.stringify({ pid: 999, start: 'x' }));
  const rel2 = acquireLock(f, { pid: 333, alive: (p) => p !== 999 }); // 999 is dead
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pid, 333);
  rel2();
  fs.writeFileSync(f, 'garbage');
  assert.throws(() => acquireLock(f, { pid: 445, alive: () => true, maxAgeMs: 60000 }).constructor, /could not take/, 'a fresh unreadable lock may be mid-write: not taken over');
  fs.utimesSync(f, new Date(0), new Date(0));
  acquireLock(f, { pid: 444, alive: () => true })();
  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('item 3: cleanup replaces the secret first, then cancels and deletes, finds lost runs, and stops dispatch', async () => {
  const calls = [];
  const tracked = [{ id: 1, status: 'in_progress', deleted: false }, { id: 2, status: 'completed', deleted: true }];
  const c = makeCleaner({
    baseId: 'pq-x', log: () => {}, secretSet: () => true, tracked: () => tracked,
    replaceSecret: async () => calls.push('secret'),
    cancel: async (id) => calls.push('cancel ' + id),
    del: async (id) => calls.push('delete ' + id),
    listRuns: async () => [{ databaseId: 1, displayTitle: 'pq-x', status: 'in_progress' }, { databaseId: 7, displayTitle: 'pq-x-p1', status: 'queued' }, { databaseId: 8, displayTitle: 'pq-other', status: 'queued' }],
  });
  c.assertRunning();
  const p = c.cleanup();
  assert.throws(() => c.assertRunning(), /no new run/, 'dispatch stops as soon as cleanup starts');
  await p;
  assert.deepEqual(calls, ['secret', 'cancel 1', 'delete 1', 'cancel 7', 'delete 7']);
  await c.cleanup();
  assert.equal(calls.length, 5, 'cleanup runs once');
  const none = [];
  await makeCleaner({ baseId: 'pq-y', log() {}, secretSet: () => false, tracked: () => [], replaceSecret: async () => none.push('secret'), cancel: async () => {}, del: async () => {}, listRuns: async () => [] }).cleanup();
  assert.deepEqual(none, [], 'secret untouched when it was never set');
});

test('item 3: the leftover sweep reads every page, not the newest 50', async () => {
  const mk = (n, pq) => Array.from({ length: n }, (_, i) => ({ displayTitle: (pq && i === n - 1 ? 'pq-late' : 'mq-' + i) }));
  const pages = [mk(100), mk(100), mk(100, true), mk(5)];
  const seen = [];
  const found = await listPrivateRuns(async (p) => { seen.push(p); return pages[p - 1] || []; });
  assert.deepEqual(found.map((r) => r.displayTitle), ['pq-late']);
  assert.deepEqual(seen, [1, 2, 3, 4]);
});

test('item 4: the key and job are gone from the environment once read', () => {
  const env = { PRIVATE_JOB: sealJob(mkJob(), KEY, 'pq-5'), PRIVATE_QA_KEY: KEY, PRIVATE_RID: 'pq-5', PATH: 'x' };
  const job = loadPrivateJob(env);
  assert.equal(job.cookies.length, 1);
  assert.ok(!('PRIVATE_QA_KEY' in env) && !('PRIVATE_JOB' in env));
  assert.equal(JSON.stringify(job).includes(KEY), false, 'the key is not part of the serialised job');
  const e2 = { PRIVATE_QA_KEY: KEY, PRIVATE_JOB: 'x' };
  assert.deepEqual(takeSecrets(e2), { job: 'x', key: KEY });
  assert.deepEqual(e2, {});
  // a child process started after the load does not see them
  const saved = { ...process.env };
  process.env.PRIVATE_JOB = sealJob(mkJob(), KEY, 'pq-6');
  process.env.PRIVATE_QA_KEY = KEY;
  process.env.PRIVATE_RID = 'pq-6';
  loadPrivateJob();
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.env.PRIVATE_QA_KEY) + String(process.env.PRIVATE_JOB))'], { encoding: 'utf8' });
  assert.equal(r.stdout, 'undefinedundefined');
  Object.assign(process.env, saved);
  delete process.env.PRIVATE_JOB;
  delete process.env.PRIVATE_QA_KEY;
});

test('item 4: the seal step takes the key out of the environment before tar runs', () => {
  const src = fs.readFileSync(new URL('../runner/private-seal.mjs', import.meta.url), 'utf8');
  assert.ok(src.indexOf('takeSecrets()') < src.indexOf('sealDir('));
  for (const f of ['ios', 'android']) assert.match(fs.readFileSync(new URL('../runner/' + f + '.mjs', import.meta.url), 'utf8'), /loadPrivateJob\(\)/);
});

test('item 6: a hostname in the log or a readable marker is a failure; cookie/key are not reported as 0', () => {
  assert.equal(leakVerdict({ logHost: 0, rawLeak: 0, logScanned: true }).fail, false);
  assert.equal(leakVerdict({ logHost: 1, rawLeak: 0, logScanned: true }).fail, true);
  assert.equal(leakVerdict({ logHost: 0, rawLeak: 2, logScanned: true }).fail, true);
  const v = leakVerdict({ logHost: 0, rawLeak: 0, logScanned: true }).lines.join('\n');
  assert.match(v, /cannot be checked/);
  assert.ok(!/cookie[^\n]*\b0\b/.test(v) && !/key[^\n]*\b0\b/.test(v));
  assert.match(leakVerdict({ logHost: 0, rawLeak: 0, logScanned: false }).lines.join('\n'), /not scanned/);
});

test('item 7: free text after [private] is dropped, only fixed messages pass', () => {
  for (const s of ['[private] ' + HOST, '[private] Nguyen Van A paid 5 trieu', '[private] cookies set: ' + COOKIE, '[private] fatal error: ' + HOST, 'device ' + HOST + ' / Android 15 | Chrome 1', 'device Acme Customer / iOS 26.2 UDID']) assert.ok(!allowedLine(s), s);
  for (const s of ['[private] cookies set: 1', '[private] emulator network not up', '[private] fatal error, details are sealed', '[private] sealed ios: 123 bytes', '[private] read-only guard active', 'device iPhone 17 / iOS 26.2 ABCDEF01-2345-6789-ABCD-EF0123456789']) assert.ok(allowedLine(s), s);
});

test('item 8: untrusted text loses control characters and is truncated', () => {
  assert.equal(untrusted('a\u001b[31mred\u0007\nb\u0085c'), 'a [31mred b c');
  assert.equal(untrusted('x'.repeat(500), 50).length, 50);
  assert.equal(untrusted(undefined), '');
});

test('item 9: cookie domains: the host or a parent with a dot, never a bare suffix', () => {
  const mk = (domain) => ({ cookies: [{ name: 'n', value: 'v'.repeat(10), domain, path: '/', expires: -1 }] });
  assert.equal(cookiesFor(mk(HOST), HOST).length, 1);
  assert.equal(cookiesFor(mk('.example-shop.test'), HOST).length, 1);
  assert.equal(cookiesFor(mk('.test'), HOST).length, 0, 'bare suffix');
  assert.equal(cookiesFor(mk('com'), 'a.example.com').length, 0);
  assert.equal(cookiesFor(mk('.co.uk'), 'shop.example.co.uk').length, 0, 'two-label suffix');
  assert.equal(cookiesFor(mk('.example.co.uk'), 'shop.example.co.uk').length, 1);
  assert.equal(cookiesFor(mk('other.test'), HOST).length, 0);
  assert.throws(() => checkPrivateTarget('https://' + HOST + './', ['/x']), /trailing dot/);
});

test('item 11: waitSettled waits for loading text to go and the text to stop changing', async () => {
  const seq = [{ len: 20, loading: true }, { len: 20, loading: true }, { len: 300, loading: false }, { len: 900, loading: false }, { len: 900, loading: false }, { len: 900, loading: false }];
  let i = 0;
  const r = await waitSettled(async () => seq[Math.min(i++, seq.length - 1)], async () => {}, { maxMs: 5000, stepMs: 0 });
  assert.equal(r.settled, true);
  assert.ok(i >= 5, 'did not stop at the first non-loading sample, used ' + i);
  const stuck = await waitSettled(async () => ({ len: 20, loading: true }), (ms) => new Promise((res) => setTimeout(res, ms)), { maxMs: 60, stepMs: 10 });
  assert.equal(stuck.settled, false);
});

test('item 2/8: the client says iOS writes are not blocked, prints untrusted data under a marker, and defaults to the scratch folder', () => {
  const src = fs.readFileSync(new URL('../bin/private-qa.mjs', import.meta.url), 'utf8');
  assert.match(src, /iOS: writes are not blocked/);
  assert.match(src, /\[untrusted\]/);
  assert.match(src, /D:\/Kit\/tmp_research\/mobile-qa-private/);
  assert.ok(!/os\.tmpdir\(\), 'mobile-qa'/.test(src), 'never %TEMP% for results');
  assert.match(src, /fs\.rmSync\(tgz, \{ force: true \}\)/);
});

const CLI = new URL('../bin/mobile-qa.mjs', import.meta.url);
const cliPath = CLI.pathname.replace(/^\/([A-Za-z]:)/, '$1');
const STUB = `import fs from 'node:fs'; import path from 'node:path';
const dir = process.env.STUB_DIR; const args = process.argv.slice(2);
const log = (s) => fs.appendFileSync(path.join(dir, 'calls.log'), s + '\\n');
const F = path.join(dir, 'runs.json');
const load = () => (fs.existsSync(F) ? JSON.parse(fs.readFileSync(F, 'utf8')) : []);
const save = (r) => fs.writeFileSync(F, JSON.stringify(r));
const stdin = () => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } };
const now = new Date().toISOString();
if (args[0] === 'auth') console.log('tok');
else if (args[0] === 'api') console.log(JSON.stringify({ workflow_runs: /page=1/.test(args[1]) ? load().map((r) => ({ id: r.id, display_title: r.title, status: r.status, created_at: now, updated_at: now })) : [] }));
else if (args[0] === 'secret' && args[1] === 'set') { stdin(); log('secret-set'); }
else if (args[0] === 'secret') console.log(JSON.stringify([{ name: 'PRIVATE_QA_KEY', updatedAt: 'x' }]));
else if (args[0] === 'workflow') { const i = JSON.parse(stdin()); save([...load(), { id: 100, title: i.request_id, status: 'in_progress' }]); log('dispatch'); }
else if (args[0] === 'run' && args[1] === 'view') { const r = load().find((x) => String(x.id) === args[2]); console.log(JSON.stringify({ status: r ? r.status : 'completed', conclusion: null, attempt: 1, jobs: [] })); }
else if (args[0] === 'run' && args[1] === 'cancel') { log('cancel'); save(load().map((r) => ({ ...r, status: 'completed' }))); }
else if (args[0] === 'run' && args[1] === 'delete') { log('delete'); save(load().filter((r) => String(r.id) !== args[2])); }
`;
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-cli-'));
  fs.writeFileSync(path.join(dir, 'stub.mjs'), STUB);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MOBILE_QA_GH_SCRIPT: path.join(dir, 'stub.mjs'), MOBILE_QA_TEST_FAST: '1', MOBILE_QA_LOCK: path.join(dir, 'l.lock'),
    STUB_DIR: dir, KITQA_BASE: BASE, KITQA_STORAGE_STATE: path.join(dir, 'state.json'), MOBILE_QA_PRIVATE_OUT: path.join(dir, 'out') };
  return { dir, env, calls: () => (fs.existsSync(path.join(dir, 'calls.log')) ? fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n') : []) };
}

test('H1: Ctrl-C in a private call runs the private cleanup to the end (real CLI, gh stub; the signal is delivered with process.emit in a child)', () => {
  const h = harness();
  try {
    fs.writeFileSync(path.join(h.dir, 'child.mjs'), [
      "import fs from 'node:fs';",
      "process.argv = [process.execPath, " + JSON.stringify(cliPath) + ", '--private', '/#sales'];",
      "await import(" + JSON.stringify(CLI.href) + ");",
      "const log = process.env.STUB_DIR + '/calls.log';",
      "for (let i = 0; i < 200 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('dispatch')); i++) await new Promise((r) => setTimeout(r, 50));",
      "await new Promise((r) => setTimeout(r, 300));",
      "process.emit('SIGINT');",
    ].join('\n'));
    const r = spawnSync(process.execPath, [path.join(h.dir, 'child.mjs')], { env: h.env, encoding: 'utf8', timeout: 60000 });
    const c = h.calls();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const second = c.indexOf('secret-set', c.indexOf('secret-set') + 1);
    assert.ok(second > 0, 'secret replaced: ' + c.join(','));
    assert.ok(c.indexOf('cancel') > second && c.indexOf('delete') > c.indexOf('cancel'), 'secret, then cancel, then delete: ' + c.join(','));
    assert.ok(!fs.existsSync(h.env.MOBILE_QA_LOCK), 'lock released');
    assert.match(r.stdout, /interrupted, cleaning up/);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('L3: anything that throws after the lock is taken still releases it (real CLI, output path is a file)', () => {
  const h = harness();
  try {
    fs.writeFileSync(path.join(h.dir, 'afile'), 'x');
    const r = spawnSync(process.execPath, [cliPath, '--private', '/#sales', '--out', path.join(h.dir, 'afile')], { env: h.env, encoding: 'utf8', timeout: 30000 });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(h.env.MOBILE_QA_LOCK), 'lock released after a throw: ' + r.stdout + r.stderr);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('M1: a failed secret rotation is reported to the caller (exit 2 path)', async () => {
  const bad = makeCleaner({ baseId: 'pq-m', log() {}, sleep: async () => {}, secretSet: () => true, tracked: () => [], replaceSecret: async () => false, cancel: async () => {}, del: async () => {}, listRuns: async () => [] });
  await bad.cleanup();
  assert.equal(bad.rotationFailed(), true);
  const ok = makeCleaner({ baseId: 'pq-m', log() {}, sleep: async () => {}, secretSet: () => true, tracked: () => [], replaceSecret: async () => true, cancel: async () => {}, del: async () => {}, listRuns: async () => [] });
  await ok.cleanup();
  assert.equal(ok.rotationFailed(), false);
  assert.match(fs.readFileSync(new URL('../bin/private-qa.mjs', import.meta.url), 'utf8'), /cleaner\.rotationFailed\(\)[\s\S]{0,120}code = 2/);
});

test('M2: a run GitHub accepted late is found by the second look, after a wait', async () => {
  const calls = [];
  let look = 0;
  const waits = [];
  await makeCleaner({ baseId: 'pq-late', log() {}, sleep: async (ms) => waits.push(ms), secretSet: () => false, tracked: () => [], replaceSecret: async () => true,
    cancel: async (id) => calls.push('cancel ' + id), del: async (id) => calls.push('delete ' + id),
    listRuns: async () => (++look === 2 ? [{ databaseId: 55, displayTitle: 'pq-late', status: 'queued' }] : []) }).cleanup();
  assert.deepEqual(waits, [10000]);
  assert.deepEqual(calls, ['cancel 55', 'delete 55']);
});

test('M3: any non-.enc file in the raw artifact is a leak', () => {
  const enc = Buffer.from('4f1c9a7b2d3e5f60718293a4b5c6d7e8', 'hex');
  assert.equal(rawArtifactLeaks([{ name: 'ios.enc', buf: enc }]), 0);
  assert.equal(rawArtifactLeaks([{ name: 'results.json', buf: Buffer.from('{}') }]), 1);
  assert.equal(rawArtifactLeaks([{ name: 'notes.txt', buf: Buffer.from('hello') }]), 1);
  assert.ok(rawArtifactLeaks([{ name: 'a.enc', buf: Buffer.from('xx' + HOST + 'yy') }], [HOST]) >= 1);
  assert.ok(rawArtifactLeaks([{ name: 'a.enc', buf: Buffer.from([0x1f, 0x8b, 1, 2, 3]) }]) >= 1);
});

test('M4: every console method goes through the allow-list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-priv-con-'));
  try {
    const lib = new URL('../runner/private.mjs', import.meta.url).href;
    fs.writeFileSync(path.join(dir, 'r.mjs'), [
      "import { loadPrivateJob, installPrivateLogging } from '" + lib + "';",
      'const P = loadPrivateJob(); installPrivateLogging(P, process.env, "ios");',
      "const secret = P.urls[0] + ' Customer Nguyen Van A';",
      "console.table([{ a: secret }]); console.dir({ a: secret }); console.trace(secret); console.assert(false, secret);",
      "console.group(secret); console.groupCollapsed(secret); console.count(secret); console.time(secret); console.timeEnd(secret); console.timeLog(secret);",
      "console.log(secret); console.debug(secret); console.dirxml(secret); console.countReset(secret); console.groupEnd();",
      "console.log('[1/1] ');",
    ].join('\n'));
    const r = spawnSync(process.execPath, [path.join(dir, 'r.mjs')], { cwd: dir, encoding: 'utf8', env: { ...process.env, PRIVATE_JOB: sealJob(mkJob(), KEY, 'pq-4'), PRIVATE_RID: 'pq-4', PRIVATE_QA_KEY: KEY } });
    const shown = (r.stdout + r.stderr).split('\n').filter((l) => !l.startsWith('::add-mask::')).join('\n');
    for (const s of [HOST, 'Nguyen', 'Customer', 'sales']) assert.ok(!shown.includes(s), 'leaked ' + s + ': ' + shown);
    assert.match(shown, /\[1\/1\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M5: the WebSocket guard and the write guard compare host names (ports and schemes do not matter)', () => {
  assert.equal(sameHost('wss://' + HOST + ':443/ws', BASE), true);
  assert.equal(sameHost('ws://' + HOST + ':8080/ws', BASE), true);
  assert.equal(sameHost('wss://other.test/ws', BASE), false);
  assert.equal(sameHost('wss://' + HOST + '.evil.test/ws', BASE), false);
  assert.equal(isBlockedWrite('POST', 'https://' + HOST + ':8443/api', BASE), true);
  assert.equal(isBlockedWrite('GET', 'https://' + HOST + ':8443/api', BASE), false);
  assert.match(fs.readFileSync(new URL('../runner/android.mjs', import.meta.url), 'utf8'), /routeWebSocket\(\(u\) => sameHost\(u\.href, PRIV\.base\)/);
});

test('L1: untrusted() removes invisible, bidi, tag and private-use characters', () => {
  const dirty = 'a\u200Bb\u202Ec\u{E0041}d\uE000e\u0378f\u2066g\uFEFFh';
  assert.equal(untrusted(dirty), 'abcdefgh');
});

test('L2: a lock older than the deadline is stale whatever its pid; takeover is by rename, one winner', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mq-lock2-')), 'l.lock');
  const t0 = Date.now();
  fs.writeFileSync(f, JSON.stringify({ pid: 4242, start: new Date(t0 - 3 * 3600000).toISOString() }));
  const rel = acquireLock(f, { pid: 1, alive: () => true, now: () => t0 }); // pid is "alive" but the lock is 3 h old
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).pid, 1);
  assert.throws(() => acquireLock(f, { pid: 2, alive: () => true, now: () => t0 }), /another private call/);
  rel();
  assert.ok(!fs.readdirSync(path.dirname(f)).some((n) => n.includes('.stale-')), 'moved-away stale locks are removed');
  assert.match(fs.readFileSync(new URL('../bin/private-qa.mjs', import.meta.url), 'utf8'), /renameSync\(file, gone\)/);
});

test('L4: ::add-mask:: values escape %, CR and LF', () => {
  assert.equal(maskCommand('a%b\r\nc'), '::add-mask::a%25b%0D%0Ac');
  assert.equal(maskCommand('plain'), '::add-mask::plain');
});

test('L5: "loading" matches as a word only', () => {
  const run = (t) => { globalThis.document = { body: { innerText: t } }; try { return settleProbe().loading; } finally { delete globalThis.document; } };
  assert.equal(run('Uploading files, Downloading report'), false);
  assert.equal(run('Page is loading'), true);
  assert.equal(run('Loading...'), true);
  assert.equal(run('Đơn hàng | Đang tải…'), true);
  assert.equal(run('Chưa tải xong, Preloading'), false);
});

test('N1: the private Android launch turns Chrome translation offers off', () => {
  assert.match(fs.readFileSync(new URL('../runner/android.mjs', import.meta.url), 'utf8'), /--disable-features=Translate/);
});

test('public CLI still installs its own signal handlers and the private one does not', () => {
  const src = fs.readFileSync(new URL('../bin/mobile-qa.mjs', import.meta.url), 'utf8');
  assert.match(src, /function installPublicSignalHandlers/);
  assert.ok(src.indexOf('runPrivate(opts') < src.indexOf('installPublicSignalHandlers();'), 'private returns before the public handlers are installed');
  assert.ok(!/^for \(const sig of/m.test(src), 'no signal handler at module load');
});
