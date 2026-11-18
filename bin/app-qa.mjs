#!/usr/bin/env node
// app-qa: build an Expo app (release) on GitHub Actions in the public repo Kasher07/mobile-qa and run its Maestro flows
// on the iOS Simulator and the Android emulator; download screenshots + results; delete the run, release and key.
// Usage: node bin/app-qa.mjs --app <expo project dir> [--platforms ios,android] [--out DIR] [--app-id <id>] [--keep]
// The app (git-tracked + untracked-not-ignored files of --app, so uncommitted work is tested) is packed, encrypted
// with a fresh AES-256-GCM key (repo secret APP_QA_KEY) and uploaded as a temporary release asset: nothing readable
// of the app stays in the public repo. Exit: 0 all flows passed, 1 a flow failed, 2 run/tool error.
import { execFileSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.MOBILE_QA_REPO || 'Kasher07/mobile-qa';
const ACCOUNT = process.env.MOBILE_QA_ACCOUNT || 'Kasher07';
const WORKFLOW = 'app-qa.yml';
const log = (s) => console.log('[app-qa] ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { app: null, platforms: 'ios,android', out: null, appId: null, keep: false, iosRunner: 'macos-26' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') o.app = argv[++i];
    else if (a === '--platforms') o.platforms = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--app-id') o.appId = argv[++i];
    else if (a === '--ios-runner') o.iosRunner = argv[++i];
    else if (a === '--keep') o.keep = true;
    else throw new Error('unknown option ' + a);
  }
  if (!o.app) throw new Error('--app <expo project dir> is required');
  if (!/^(ios|android|ios,android|android,ios)$/.test(o.platforms)) throw new Error('--platforms must be ios, android or ios,android');
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const appDir = path.resolve(opts.app);
const appJson = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8')).expo;
const appId = opts.appId || appJson.ios?.bundleIdentifier || appJson.android?.package;
if (!/^[A-Za-z0-9.]+$/.test(appId || '')) throw new Error('cannot tell the app id; pass --app-id');
if (!fs.existsSync(path.join(appDir, '.maestro'))) throw new Error('no .maestro folder in ' + appDir);
const token = execFileSync('gh', ['auth', 'token', '--user', ACCOUNT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const env = { ...process.env, GH_TOKEN: token };
const gh = (args, o = {}) => execFileSync('gh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...o });
const rid = 'aq-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + randomBytes(2).toString('hex');
const tag = 'app-qa-' + rid;
const outDir = path.resolve(opts.out || path.join(os.tmpdir(), rid));
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'app-qa-'));

// ---- pack + encrypt
const files = execFileSync('git', ['-C', appDir, 'ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\n').filter((f) => f && fs.existsSync(path.join(appDir, f)));
fs.writeFileSync(path.join(work, 'list.txt'), files.join('\n') + '\n');
const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tarBin, ['-czf', path.join(work, 'app.tgz'), '-T', path.join(work, 'list.txt')], { cwd: appDir });
const key = randomBytes(32);
const iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([c.update(fs.readFileSync(path.join(work, 'app.tgz'))), c.final()]);
fs.writeFileSync(path.join(work, 'app.tgz.enc'), Buffer.concat([iv, c.getAuthTag(), enc]));
fs.rmSync(path.join(work, 'app.tgz'));
log(files.length + ' files packed, ' + Math.round(enc.length / 1e6 * 10) / 10 + ' MB encrypted');

let runId = null;
let released = false;
async function cleanup() {
  if (runId && !opts.keep) { try { gh(['run', 'delete', String(runId), '-R', REPO]); log('run deleted'); } catch (e) { log('delete the run by hand: https://github.com/' + REPO + '/actions/runs/' + runId); } }
  if (released) { try { gh(['release', 'delete', tag, '-R', REPO, '--cleanup-tag', '-y']); log('release deleted'); } catch { log('delete release ' + tag + ' by hand'); } }
  try { gh(['secret', 'set', 'APP_QA_KEY', '-R', REPO, '--body', randomBytes(32).toString('hex')]); } catch { /* best effort: the old key is useless once the release is gone */ }
  fs.rmSync(work, { recursive: true, force: true });
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { log('interrupted, cleaning up'); cleanup().finally(() => process.exit(2)); });

let code = 2;
try {
  gh(['secret', 'set', 'APP_QA_KEY', '-R', REPO, '--body', key.toString('hex')]);
  gh(['release', 'create', tag, path.join(work, 'app.tgz.enc'), '-R', REPO, '--title', tag, '--notes', 'Temporary encrypted input of an app-qa run; deleted when the run ends.', '--prerelease']);
  released = true;
  gh(['workflow', 'run', WORKFLOW, '-R', REPO, '-f', 'request_id=' + rid, '-f', 'asset_tag=' + tag, '-f', 'platforms=' + opts.platforms, '-f', 'app_id=' + appId, '-f', 'ios_runner=' + opts.iosRunner]);
  for (let t = 0; !runId && t < 24; t++) {
    await sleep(5000);
    const l = JSON.parse(gh(['run', 'list', '-R', REPO, '-w', WORKFLOW, '-L', '20', '--json', 'databaseId,displayTitle']));
    runId = l.find((x) => x.displayTitle === rid)?.databaseId ?? null;
  }
  if (!runId) throw new Error('run not found');
  log('run ' + rid + ': https://github.com/' + REPO + '/actions/runs/' + runId);
  let last = '';
  const deadline = Date.now() + 150 * 60000;
  for (;;) {
    const v = JSON.parse(gh(['run', 'view', String(runId), '-R', REPO, '--json', 'status,conclusion,jobs']));
    const line = v.jobs.map((j) => j.name + ':' + (j.conclusion || j.status) + (j.steps?.find((s) => s.status === 'in_progress') ? ' (' + j.steps.find((s) => s.status === 'in_progress').name + ')' : '')).join(' | ');
    if (line !== last) { log(line); last = line; }
    if (v.status === 'completed') { code = v.conclusion === 'success' ? 0 : 1; break; }
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(30000);
  }
  try { gh(['run', 'download', String(runId), '-R', REPO, '-D', outDir]); } catch (e) { log('download failed: ' + String(e.stderr || e.message).slice(0, 200)); code = 2; }
  if (code !== 0) {
    try { fs.writeFileSync(path.join(outDir, 'failed.log'), gh(['run', 'view', String(runId), '-R', REPO, '--log-failed'])); log('failed-step log: ' + path.join(outDir, 'failed.log')); } catch { /* none */ }
  }
  for (const p of opts.platforms.split(',')) {
    const ck = path.join(outDir, p, 'checks.txt');
    if (fs.existsSync(ck)) log(p + ' checks:\n' + fs.readFileSync(ck, 'utf8').trim());
    for (const pass of ['light', 'dark-large']) {
      const j = path.join(outDir, p, pass, 'junit.xml');
      if (!fs.existsSync(j)) { log(p + '/' + pass + ': no results'); continue; }
      const x = fs.readFileSync(j, 'utf8');
      const cases = [...x.matchAll(/<testcase[^>]*name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)];
      for (const m of cases) log(p + '/' + pass + ': ' + (/<failure/.test(m[3] || '') ? 'FAIL ' : 'ok   ') + m[1] + (/<failure/.test(m[3] || '') ? ' - ' + (m[3].match(/message="([^"]*)"/)?.[1] || '').slice(0, 300) : ''));
    }
  }
  log('results: ' + outDir);
} catch (e) {
  log('error: ' + e.message);
  code = 2;
} finally {
  await cleanup();
}
process.exit(code);
