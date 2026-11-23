#!/usr/bin/env node
// app-qa: build an Expo app (release) on GitHub Actions in the public repo Kasher07/mobile-qa and run its Maestro flows
// on the iOS Simulator and the Android emulator; download screenshots + results; delete the run, release and key.
// Usage: node bin/app-qa.mjs --app <expo project dir> [--platforms ios,android] [--flows a,b] [--dark a,b|none]
//        [--full] [--out DIR] [--app-id <id>] [--keep]
// Fast path: --flows runs only the flows a change touches; a JS-only change (same Expo fingerprint and media files as
// an earlier run on this machine) reuses that run's release build and replaces only the JS (no native build).
// --full forces a native build. --dark: flows for the dark + largest-text pass (default: .maestro/dark-flows.txt on a
// run of every flow, none with --flows).
// The app (git-tracked + untracked-not-ignored files of --app, so uncommitted work is tested) is packed, encrypted
// with a fresh AES-256-GCM key (repo secret APP_QA_KEY) and uploaded as a temporary release asset: nothing readable
// of the app stays in the public repo. Exit: 0 all flows passed, 1 a flow failed, 2 run/tool error.
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findShell, mediaHash, nativeFingerprint, shellKey, storeShell } from './app-qa-shell.mjs';

const REPO = process.env.MOBILE_QA_REPO || 'Kasher07/mobile-qa';
const ACCOUNT = process.env.MOBILE_QA_ACCOUNT || 'Kasher07';
const WORKFLOW = 'app-qa.yml';
const log = (s) => console.log('[app-qa] ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { app: null, platforms: 'ios,android', out: null, appId: null, keep: false, iosRunner: 'macos-26', flows: null, dark: null, full: false, iosOn: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') o.app = argv[++i];
    else if (a === '--platforms') o.platforms = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--app-id') o.appId = argv[++i];
    else if (a === '--ios-runner') o.iosRunner = argv[++i];
    else if (a === '--keep') o.keep = true;
    else if (a === '--flows') o.flows = argv[++i];
    else if (a === '--dark') o.dark = argv[++i];
    else if (a === '--full') o.full = true;
    else if (a === '--ios-on') o.iosOn = argv[++i];
    else throw new Error('unknown option ' + a);
  }
  if (!o.app) throw new Error('--app <expo project dir> is required');
  if (!/^(ios|android|ios,android|android,ios)$/.test(o.platforms)) throw new Error('--platforms must be ios, android or ios,android');
  for (const k of ['flows', 'dark']) if (o[k] != null && !/^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$/.test(o[k])) throw new Error('--' + k + ' takes flow names without .yaml, comma-separated');
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const appDir = path.resolve(opts.app);
const appJson = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8')).expo;
const appId = opts.appId || appJson.ios?.bundleIdentifier || appJson.android?.package;
if (!/^[A-Za-z0-9.]+$/.test(appId || '')) throw new Error('cannot tell the app id; pass --app-id');
if (!fs.existsSync(path.join(appDir, '.maestro'))) throw new Error('no .maestro folder in ' + appDir);
const flowNames = fs.readdirSync(path.join(appDir, '.maestro')).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5));
const darkFile = path.join(appDir, '.maestro', 'dark-flows.txt');
const darkDefault = fs.existsSync(darkFile) ? fs.readFileSync(darkFile, 'utf8').split(/\s+/).filter(Boolean).join(',') : '';
const flowsLight = opts.flows || '*';
const flowsDark = opts.dark === 'none' ? '' : opts.dark || (opts.flows ? '' : darkDefault);
for (const f of [flowsLight, flowsDark].join(',').split(',').filter((x) => x && x !== '*')) {
  if (!flowNames.includes(f)) throw new Error('no flow .maestro/' + f + '.yaml');
}
// One job per flow and pass on each platform, run in parallel (shards).
const shards = [
  ...(flowsLight === '*' ? flowNames.sort() : flowsLight.split(',')).map((flow) => ({ flow, pass: 'light' })),
  ...flowsDark.split(',').filter(Boolean).map((flow) => ({ flow, pass: 'dark' })),
];
const started = Date.now();

// ---- iOS on Codemagic (Mac mini M2, free 500 min/month, one build at a time): faster than GitHub's free Mac for a
// sequential iOS session. Token: CODEMAGIC_TOKEN or %LOCALAPPDATA%/kit-app-qa/codemagic.token; app id in codemagic.json
// there (created for the public repo). --ios-on github forces the GitHub shards.
const cmDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'kit-app-qa');
const cmToken = process.env.CODEMAGIC_TOKEN || (fs.existsSync(path.join(cmDir, 'codemagic.token')) ? fs.readFileSync(path.join(cmDir, 'codemagic.token'), 'utf8').trim() : '');
const cmConf = fs.existsSync(path.join(cmDir, 'codemagic.json')) ? JSON.parse(fs.readFileSync(path.join(cmDir, 'codemagic.json'), 'utf8')) : null;
const useCm = opts.platforms.includes('ios') && opts.iosOn !== 'github' && !!cmToken && !!cmConf?.appId;
if (opts.iosOn === 'codemagic' && !useCm) throw new Error('--ios-on codemagic needs the Codemagic token and app id in ' + cmDir);
const ghPlatforms = opts.platforms.split(',').filter((p) => !(p === 'ios' && useCm)).join(',');
const cmApi = async (method, url, body) => {
  const r = await fetch('https://api.codemagic.io' + url, { method, headers: { 'x-auth-token': cmToken, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error('Codemagic ' + method + ' ' + url + ': HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
};
let cmBuildId = null;
let cmFinished = false;
const token = execFileSync('gh', ['auth', 'token', '--user', ACCOUNT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const env = { ...process.env, GH_TOKEN: token };
const gh = (args, o = {}) => execFileSync('gh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...o });
// The key goes through stdin, never the command line (other processes and audit logs can read argv).
const setKey = (hex) => execFileSync('gh', ['secret', 'set', 'APP_QA_KEY', '-R', REPO], { env, input: hex, stdio: ['pipe', 'pipe', 'pipe'] });

// ---- one run at a time (they share APP_QA_KEY); leftovers of a killed caller are removed first
const ageMin = (t) => (Date.now() - Date.parse(t)) / 60000;
function sweepAndLock() {
  const runs = JSON.parse(gh(['run', 'list', '-R', REPO, '-w', WORKFLOW, '-L', '50', '--json', 'databaseId,displayTitle,status,createdAt,updatedAt']));
  for (const r of runs) {
    if (r.status !== 'completed' && ageMin(r.createdAt) > 180) { try { gh(['run', 'cancel', String(r.databaseId), '-R', REPO]); log('cancelled abandoned run ' + r.displayTitle); } catch { /* already ending */ } }
    if (r.status === 'completed' && ageMin(r.updatedAt) > 30) { try { gh(['run', 'delete', String(r.databaseId), '-R', REPO]); log('deleted leftover run ' + r.displayTitle); } catch { /* gone */ } }
  }
  const active = runs.filter((r) => r.status !== 'completed' && ageMin(r.createdAt) <= 180);
  if (active.length) throw new Error('another app-qa run is active (' + active.map((r) => r.displayTitle).join(', ') + '); try again when it ends');
  const rels = JSON.parse(gh(['release', 'list', '-R', REPO, '-L', '100', '--json', 'tagName,createdAt']));
  for (const r of rels.filter((x) => x.tagName.startsWith('app-qa-'))) {
    if (ageMin(r.createdAt) > 180) { try { gh(['release', 'delete', r.tagName, '-R', REPO, '--cleanup-tag', '-y']); log('deleted leftover release ' + r.tagName); } catch { /* gone */ } }
    else throw new Error('release ' + r.tagName + ' of another app-qa call exists; try again later');
  }
}
const rid = 'aq-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + randomBytes(2).toString('hex');
const tag = 'app-qa-' + rid;
const outDir = path.resolve(opts.out || path.join(os.tmpdir(), rid));
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'app-qa-'));

// ---- pack + encrypt
const files = execFileSync('git', ['-C', appDir, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\n').filter((f) => f && fs.existsSync(path.join(appDir, f)));
// Never ship credentials to a runner, even encrypted: build code there could read them.
const SECRETISH = /(^|\/)(\.env(\..*)?|.*\.(keystore|jks|p8|p12|pem|key|mobileprovision)|credentials\.json|google-services\.json|GoogleService-Info\.plist|.*service-account.*\.json)$/i;
const risky = files.filter((f) => SECRETISH.test(f));
if (risky.length) throw new Error('refusing to send credential-like files: ' + risky.join(', ') + ' (ignore or move them)');
fs.writeFileSync(path.join(work, 'list.txt'), files.join('\n') + '\n');
const gitTar = process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'tar.exe')].find((f) => fs.existsSync(f)) : null;
const unpackTar = gitTar || 'tar';
const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tarBin, ['-czf', path.join(work, 'app.tgz'), '-T', path.join(work, 'list.txt')], { cwd: appDir });
const key = randomBytes(32);
const iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([c.update(fs.readFileSync(path.join(work, 'app.tgz'))), c.final()]);
fs.writeFileSync(path.join(work, 'app.tgz.enc'), Buffer.concat([iv, c.getAuthTag(), enc]));
fs.rmSync(path.join(work, 'app.tgz'));
log(files.length + ' files packed, ' + Math.round(enc.length / 1e6 * 10) / 10 + ' MB encrypted');

// ---- reuse an earlier release build when only JS changed
const fp = opts.full ? null : nativeFingerprint(appDir);
const sk = shellKey(fp, mediaHash(appDir, files));
const reuse = [];
for (const p of opts.platforms.split(',')) {
  const shell = findShell(appId, p, sk);
  if (!shell) continue;
  const iv2 = randomBytes(12);
  const c2 = createCipheriv('aes-256-gcm', key, iv2);
  const body = Buffer.concat([c2.update(fs.readFileSync(shell)), c2.final()]);
  fs.writeFileSync(path.join(work, 'shell-' + p + '.tgz.enc'), Buffer.concat([iv2, c2.getAuthTag(), body]));
  reuse.push(p);
}
log(opts.full ? 'full native build (--full)' : !fp ? 'no Expo fingerprint (node_modules missing?): full native build'
  : reuse.length ? 'JS-only change: reusing the earlier build for ' + reuse.join(', ') + (reuse.length < opts.platforms.split(',').length ? '; native build for the rest' : '')
  : 'native code or media changed since the last kept build: full native build');
log('flows: ' + (flowsLight === '*' ? 'all (' + flowNames.length + ')' : flowsLight) + (flowsDark ? '; dark + largest text: ' + flowsDark : '; no dark pass'));

let runId = null;
let dispatched = false;
const findRun = () => JSON.parse(gh(['run', 'list', '-R', REPO, '-w', WORKFLOW, '-L', '20', '--json', 'databaseId,displayTitle'])).find((x) => x.displayTitle === rid)?.databaseId ?? null;
let cleaning = null;
function cleanup() {
  cleaning ??= (async () => {
    if (cmBuildId && !cmFinished) { try { await cmApi('POST', '/builds/' + cmBuildId + '/cancel'); log('Codemagic build cancelled'); } catch { /* finished or gone */ } }
    if (!runId && dispatched) { try { runId = findRun(); } catch { /* below */ } }
    if (runId && !opts.keep) {
      try {
        const st = JSON.parse(gh(['run', 'view', String(runId), '-R', REPO, '--json', 'status'])).status;
        if (st !== 'completed') {
          gh(['run', 'cancel', String(runId), '-R', REPO]);
          for (let t = 0; t < 24 && JSON.parse(gh(['run', 'view', String(runId), '-R', REPO, '--json', 'status'])).status !== 'completed'; t++) await sleep(5000);
        }
        gh(['run', 'delete', String(runId), '-R', REPO]);
        log('run deleted');
      } catch { log('could not delete the run; the next app-qa call removes it: https://github.com/' + REPO + '/actions/runs/' + runId); }
    } else if (dispatched && !runId) log('run of ' + rid + ' not found; the next app-qa call removes it');
    try { gh(['release', 'delete', tag, '-R', REPO, '--cleanup-tag', '-y']); log('release deleted'); } catch { /* never created, or already gone */ }
    try { setKey(randomBytes(32).toString('hex')); } catch (e) { log('WARNING: could not replace APP_QA_KEY: ' + String(e.stderr || e.message).slice(0, 150)); }
    fs.rmSync(work, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { log('interrupted, cleaning up'); cleanup().finally(() => process.exit(2)); });

async function runCodemagic() {
  const b = await cmApi('POST', '/builds', { appId: cmConf.appId, workflowId: cmConf.workflowId || 'app-qa-ios', branch: 'main',
    environment: { variables: { ASSET_TAG: tag, APP_ID: appId, APP_QA_KEY: key.toString('hex'), REUSE: reuse.join(','), SHARDS: JSON.stringify(shards) } } });
  cmBuildId = b.buildId;
  log('ios on Codemagic M2: https://codemagic.io/app/' + cmConf.appId + '/build/' + cmBuildId);
  let last = '';
  const t0 = Date.now();
  const deadline = Date.now() + 60 * 60000;
  for (;;) {
    let build;
    try { build = (await cmApi('GET', '/builds/' + cmBuildId)).build; } catch (e) { log(String(e.message).slice(0, 160)); await sleep(20000); continue; }
    const step = (build.buildActions || []).find((a) => a.status === 'building')?.name;
    const line = 'ios (Codemagic): ' + build.status + (step ? ' (' + step + ')' : '');
    if (line !== last) { log(line); last = line; }
    if (['finished', 'failed', 'canceled', 'timeout', 'skipped'].includes(build.status)) {
      cmFinished = true;
      log('time ios (Codemagic): takes ' + Math.round((Date.now() - t0) / 6000) / 10 + ' min');
      for (const a of build.buildActions || []) if (a.startedAt && a.finishedAt) log('time ios | ' + a.name + ' | ' + Math.round((Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 1000) + ' s');
      // Codemagic gives one file per artefact, or one zip when there are several.
      const files = [];
      const cmTmp = path.join(work, 'codemagic');
      fs.mkdirSync(cmTmp, { recursive: true });
      for (const art of build.artefacts || []) {
        const r = await fetch(art.url, { headers: { 'x-auth-token': cmToken } });
        if (!r.ok) { log('could not download ' + art.name + ': HTTP ' + r.status); continue; }
        const f = path.join(cmTmp, path.basename(art.name));
        fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
        if (f.endsWith('.zip')) {
          execFileSync(tarBin, ['-xf', path.basename(f)], { cwd: cmTmp, stdio: 'ignore' });
          const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
          files.push(...walk(cmTmp).filter((x) => x.endsWith('.enc')));
        } else files.push(f);
      }
      for (const f of files) {
        const name = path.basename(f);
        const m = /^(app|build)-ios\.enc$/.exec(name) || /^(ios-.+)\.enc$/.exec(name);
        if (!m) continue;
        const folder = m[1] === 'app' || m[1] === 'build' ? m[1] + '-ios' : 'res-' + m[1];
        fs.mkdirSync(path.join(outDir, folder), { recursive: true });
        fs.copyFileSync(f, path.join(outDir, folder, name));
      }
      if (!files.length) log('Codemagic: no results came back');
      return build.status === 'finished' ? 0 : 1;
    }
    if (Date.now() > deadline) throw new Error('Codemagic build timed out');
    await sleep(20000);
  }
}

let code = 2;
try {
  sweepAndLock();
  setKey(key.toString('hex'));
  gh(['release', 'create', tag, path.join(work, 'app.tgz.enc'), ...reuse.map((p) => path.join(work, 'shell-' + p + '.tgz.enc')), '-R', REPO, '--title', tag, '--notes', 'Temporary encrypted input of an app-qa run; deleted when the run ends.', '--prerelease']);
  const cmDone = useCm ? runCodemagic().catch((e) => { log('Codemagic: ' + e.message); return 2; }) : null;
  if (!ghPlatforms) code = 0;
  if (ghPlatforms) {
  dispatched = true;
  gh(['workflow', 'run', WORKFLOW, '-R', REPO, '-f', 'request_id=' + rid, '-f', 'asset_tag=' + tag, '-f', 'platforms=' + ghPlatforms, '-f', 'app_id=' + appId, '-f', 'ios_runner=' + opts.iosRunner,
    '-f', 'shards=' + JSON.stringify(shards), '-f', 'reuse=' + reuse.join(',')]);
  for (let t = 0; !runId && t < 24; t++) {
    await sleep(5000);
    runId = findRun();
  }
  if (!runId) throw new Error('run not found');
  log('run ' + rid + ': https://github.com/' + REPO + '/actions/runs/' + runId);
  let last = '';
  const deadline = Date.now() + 150 * 60000;
  let apiErrors = 0;
  for (;;) {
    let v;
    try {
      v = JSON.parse(gh(['run', 'view', String(runId), '-R', REPO, '--json', 'status,conclusion,jobs']));
      apiErrors = 0;
    } catch (e) {
      // GitHub answers 5xx now and then: keep waiting rather than throwing the run away.
      if (++apiErrors > 20) throw e;
      log('GitHub API error while polling (' + String(e.stderr || e.message).split('\n')[0].slice(0, 120) + '), retrying');
      await sleep(30000);
      continue;
    }
    const line = v.jobs.map((j) => j.name + ':' + (j.conclusion || j.status) + (j.steps?.find((s) => s.status === 'in_progress') ? ' (' + j.steps.find((s) => s.status === 'in_progress').name + ')' : '')).join(' | ');
    if (line !== last) { log(line); last = line; }
    if (v.status === 'completed') {
      code = v.conclusion === 'success' ? 0 : 1;
      // Where the time went, per job (the run itself is deleted afterwards).
      const t0 = Date.parse(v.jobs.map((j) => j.startedAt).filter(Boolean).sort()[0] || 0);
      const mins = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 6000) / 10;
      for (const j of v.jobs) if (j.startedAt && j.completedAt && j.conclusion !== 'skipped') log('time ' + j.name + ': starts +' + mins(new Date(t0).toISOString(), j.startedAt) + ' min, takes ' + mins(j.startedAt, j.completedAt) + ' min');
      const steps = v.jobs.flatMap((j) => (j.steps || []).filter((x) => x.startedAt && x.completedAt && !x.startedAt.startsWith('0001'))
        .map((x) => j.name + ' | ' + x.name + ' | ' + Math.round((Date.parse(x.completedAt) - Date.parse(x.startedAt)) / 1000) + ' s'));
      fs.writeFileSync(path.join(outDir, 'timings.txt'), steps.join('\n') + '\n');
      for (const j of v.jobs.filter((x) => x.conclusion !== 'success')) {
        try {
          const ann = JSON.parse(gh(['api', 'repos/' + REPO + '/check-runs/' + j.databaseId + '/annotations']));
          for (const a of ann) log(j.name + ' annotation: ' + String(a.message).slice(0, 400));
        } catch { /* none */ }
      }
      break;
    }
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(30000);
  }
  try { gh(['run', 'download', String(runId), '-R', REPO, '-D', outDir]); } catch (e) { log('download failed: ' + String(e.stderr || e.message).slice(0, 200)); code = 2; }
  }
  if (cmDone) code = Math.max(code, await cmDone);
  // Artifacts are sealed with this run's key: open them here. gh puts each artifact in a folder named after it.
  const openSealed = (file) => {
    const blob = fs.readFileSync(file);
    const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12), { authTagLength: 16 });
    d.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  };
  for (const name of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
    const dir = path.join(outDir, name);
    const m = /^(app|build|res)-(.+)$/.exec(name);
    if (!m || !fs.statSync(dir).isDirectory()) continue;
    const sealed = fs.readdirSync(dir).find((f) => f.endsWith('.enc'));
    if (!sealed) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
    try {
      const plain = openSealed(path.join(dir, sealed));
      if (m[1] === 'app') {
        // A fresh native build is kept on this machine for the next JS-only run; a repacked one is not.
        const platform = m[2];
        const tmpShell = path.join(work, 'shell-' + platform + '.tgz');
        fs.writeFileSync(tmpShell, plain);
        const kept = sk && !reuse.includes(platform) ? storeShell(appId, platform, sk, tmpShell) : null;
        if (kept) log(platform + ': build kept for JS-only runs (' + Math.round(fs.statSync(kept).size / 1e6) + ' MB)');
      } else {
        // Maestro names folders after the flows (Vietnamese): Windows' bsdtar cannot write those names, Git's GNU tar
        // can. Relative paths and cwd keep GNU tar from reading "D:" as a remote host.
        const target = path.join(outDir, m[2]);
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'r.tgz'), plain);
        execFileSync(unpackTar, ['-xzf', 'r.tgz'], { cwd: target, stdio: ['ignore', 'pipe', 'pipe'] });
        fs.rmSync(path.join(target, 'r.tgz'));
      }
    } catch (e) {
      log(name + ': could not open (' + String(e.stderr || e.message).split('\n')[0].slice(0, 160) + ')');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (code !== 0) {
    try { fs.writeFileSync(path.join(outDir, 'failed.log'), gh(['run', 'view', String(runId), '-R', REPO, '--log-failed'])); log('failed-step log: ' + path.join(outDir, 'failed.log')); } catch { /* none */ }
  }
  for (const p of opts.platforms.split(',')) {
    let checked = false;
    for (const sh of shards) {
      const dir = path.join(outDir, p + '-' + sh.pass + '-' + sh.flow);
      const ck = path.join(dir, 'checks.txt');
      if (!checked && sh.pass === 'light' && fs.existsSync(ck)) { log(p + ' checks:\n' + fs.readFileSync(ck, 'utf8').trim()); checked = true; }
      const j = path.join(dir, 'junit.xml');
      if (!fs.existsSync(j)) { log(p + '/' + sh.pass + ' ' + sh.flow + ': no results'); code = Math.max(code, 1); continue; }
      const x = fs.readFileSync(j, 'utf8');
      const cases = [...x.matchAll(/<testcase[^>]*name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)];
      if (cases.some((c) => /<failure/.test(c[3] || ''))) code = Math.max(code, 1);
      for (const c of cases) log(p + '/' + sh.pass + ': ' + (/<failure/.test(c[3] || '') ? 'FAIL ' : 'ok   ') + c[1] + (/<failure/.test(c[3] || '') ? ' - ' + (c[3].match(/message="([^"]*)"/)?.[1] || '').slice(0, 300) : ''));
    }
  }
  log('results: ' + outDir + ' (' + Math.round((Date.now() - started) / 6000) / 10 + ' min)');
} catch (e) {
  log('error: ' + e.message);
  code = 2;
} finally {
  await cleanup();
}
process.exit(code);
