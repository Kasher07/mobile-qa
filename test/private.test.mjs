import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { sealJob, openJob, seal, unseal, resultAad, checkPrivateTarget, cookiesFor, buildJob, allowedLine, sealDir, toWebDriverCookies, toPlaywrightCookies, validateJob } from '../runner/private.mjs';
import { leakScan } from '../bin/private-qa.mjs';
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
      'installPrivateLogging(PRIV);',
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
    assert.ok(fs.existsSync(path.join(dir, 'out', 'fatal.txt')), 'the crash detail goes to the sealed folder');
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
        assert.match(s.if, /inputs\.private_job != ''/, name + ': ' + s.name + ' must run only for private runs');
      }
      if (/runner\/(ios|android)\.mjs/.test(JSON.stringify(s)) && !uses) assert.match(s.if || '', /inputs\.private_job == ''/, name + ': a public runner step must be skipped in private runs');
      if (s.uses && s.uses.startsWith('actions/upload-artifact')) {
        const isPriv = /private_job != ''/.test(s.if || '');
        assert.equal(s.with.path.startsWith('sealed/'), isPriv, name + ': private runs upload only sealed/, public ones only out/');
      }
    }
  }
  assert.ok(guarded >= 5, 'expected the private runner, seal and emulator steps, got ' + guarded);
});
