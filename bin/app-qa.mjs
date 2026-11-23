#!/usr/bin/env node
// app-qa: run an Expo app's Maestro flows on real release builds: Android on the GitHub emulator (one job per flow,
// in parallel) in the public repo Kasher07/mobile-qa, iOS on a Codemagic Mac mini M2 (all flows in one simulator
// session) or on GitHub Mac shards. Which one: bin/app-qa-pool.mjs asks every Codemagic account (kit folder:
// codemagic.json, codemagic-2.json, ...) whether it is idle and has minutes left; none does (or none is configured) =
// GitHub shards, never a queue.
//
// Usage: node bin/app-qa.mjs --app <expo project dir> [--changed | --flows a,b [--dark a,b]] [--platforms ios,android]
//        [--ios background|wait] [--ios-on codemagic|codemagic:<n>|github] [--full] [--out DIR] [--app-id <id>] [--keep]
//   --changed  only the flows the files changed since that platform's last passing run need (.maestro/flows-map.json);
//              nothing changed that a flow covers = no run at all
//   --flows    these flows (light), --dark these again in dark mode with the largest text
//   (neither)  every flow + .maestro/dark-flows.txt (before a store build)
//   --ios-when risk|always   with --changed and --ios background: "risk" starts iOS now only when something iOS-specific
//              changed (flows-map.json "ios" rule); otherwise iOS waits for the next call that says "always" (a land step or a
//              release), which runs every iOS flow for everything changed since iOS last passed. Default always.
//   --unit-covered a,b   changed files (relative to the app) that a unit test green in this run imports directly: only
//              those the map names in "unitOnly" are then skipped (see splitByCoverage in bin/app-qa-select.mjs)
//   --lang vi|en   language of the one-line decision this tool prints
//   --plan-only   print what would run (flows, lane decision line) and stop: nothing packed, started or written
//   --ios      background (default): wait for Android only; iOS finishes in a detached process and the next call
//              prints its result; wait: wait for both (store builds)
// Speed: a JS-only change (same Expo fingerprint and media files as a build kept on this machine) reuses that build
// and replaces only the JS (no Xcode/Gradle); --full forces a native build.
// The app (git-tracked + untracked-not-ignored files, so uncommitted work is tested) is packed, encrypted with a fresh
// AES-256-GCM key (repo secret APP_QA_KEY / a Codemagic build variable) and uploaded as a temporary release asset:
// nothing readable of the app stays in the public repo. Exit: 0 passed (or nothing to run), 1 a flow failed, 2 error.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codemagic, codemagicConfigs, kitDir, makeLog, openArtifacts, seal, sleep, summarize, tarBin } from './app-qa-lib.mjs';
import { markIosResultSeen, readUnseenIosResults } from './app-qa-ios-results.mjs';
import { chooseIosLane, parseIosOn } from './app-qa-pool.mjs';
import { changedSince, describeDecision, fileMapHash, iosRisk, moveLastPass, readLastPass, readPendingIos, selectFlows, snapshot, splitByCoverage, writePendingIos } from './app-qa-select.mjs';
import { findShell, mediaHash, nativeFingerprint, shellKey, storeShell } from './app-qa-shell.mjs';

const REPO = process.env.MOBILE_QA_REPO || 'Kasher07/mobile-qa';
const ACCOUNT = process.env.MOBILE_QA_ACCOUNT || 'Kasher07';
const WORKFLOW = 'app-qa.yml';
const log = makeLog('app-qa');
const FLOWS_RE = /^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$/;

function parseArgs(argv) {
  const o = { app: null, platforms: 'ios,android', out: null, appId: null, keep: false, iosRunner: 'macos-26', flows: null, dark: null, changed: false, full: false, iosOn: null, ios: 'background', iosWhen: 'always', unitCovered: null, lang: 'en', planOnly: false };
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
    else if (a === '--changed') o.changed = true;
    else if (a === '--full') o.full = true;
    else if (a === '--ios-on') o.iosOn = argv[++i];
    else if (a === '--ios') o.ios = argv[++i];
    else if (a === '--ios-when') o.iosWhen = argv[++i];
    else if (a === '--unit-covered') o.unitCovered = argv[++i];
    else if (a === '--lang') o.lang = argv[++i];
    else if (a === '--plan-only') o.planOnly = true;
    else throw new Error('unknown option ' + a);
  }
  if (!o.app) throw new Error('--app <expo project dir> is required');
  if (!/^(ios|android|ios,android|android,ios)$/.test(o.platforms)) throw new Error('--platforms must be ios, android or ios,android');
  for (const k of ['flows', 'dark']) if (o[k] != null && o[k] !== 'none' && !FLOWS_RE.test(o[k])) throw new Error('--' + k + ' takes flow names without .yaml, comma-separated');
  parseIosOn(o.iosOn);
  if (!/^(background|wait)$/.test(o.ios)) throw new Error('--ios must be background or wait');
  if (!/^(risk|always)$/.test(o.iosWhen)) throw new Error('--ios-when must be risk or always');
  if (!/^(vi|en)$/.test(o.lang)) throw new Error('--lang must be vi or en');
  if (o.changed && o.flows) throw new Error('--changed and --flows exclude each other');
  return o;
}

const opts = parseArgs(process.argv.slice(2));
const started = Date.now();
const appDir = path.resolve(opts.app);
const appJson = JSON.parse(fs.readFileSync(path.join(appDir, 'app.json'), 'utf8')).expo;
const appId = opts.appId || appJson.ios?.bundleIdentifier || appJson.android?.package;
if (!/^[A-Za-z0-9.]+$/.test(appId || '')) throw new Error('cannot tell the app id; pass --app-id');
const maestroDir = path.join(appDir, '.maestro');
if (!fs.existsSync(maestroDir)) throw new Error('no .maestro folder in ' + appDir);
const flowNames = fs.readdirSync(maestroDir).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort();
const readList = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\s+/).filter(Boolean) : []);
const darkDefault = readList(path.join(maestroDir, 'dark-flows.txt'));
const flowMap = fs.existsSync(path.join(maestroDir, 'flows-map.json')) ? JSON.parse(fs.readFileSync(path.join(maestroDir, 'flows-map.json'), 'utf8')) : null;
for (const f of [opts.flows, opts.dark].filter((x) => x && x !== 'none').join(',').split(',').filter(Boolean)) {
  if (!flowNames.includes(f)) throw new Error('no flow .maestro/' + f + '.yaml');
}

// ---- background iOS results nobody has read yet (every one, oldest first; a failure is never overwritten by a later run)
let previousIosFailed = false;
if (!opts.planOnly) {
  for (const entry of readUnseenIosResults(appId)) {
    const r = entry.rec;
    // A background iOS failure stops this call (exit 1) once, so a verify step or a commit notices it; the iOS
    // snapshot did not move, so --changed runs those iOS flows again.
    if (!r.ok) previousIosFailed = true;
    log('iOS of an earlier call (' + r.at + '): ' + (r.ok ? 'passed' : 'FAILED') + ' - ' + r.outDir);
    for (const l of r.lines || []) log('  ' + l.replace(/^\[app-qa ios\] /, ''));
    markIosResultSeen(entry);
  }
}

// ---- what to pack, and which flows each platform needs
const files = execFileSync('git', ['-C', appDir, 'ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\0').filter((f) => f && fs.existsSync(path.join(appDir, f)));
// Never ship credentials to a runner, even encrypted: build code there could read them.
const SECRETISH = /(^|\/)(\.env(\..*)?|.*\.(keystore|jks|p8|p12|pem|key|mobileprovision)|credentials\.json|google-services\.json|GoogleService-Info\.plist|.*service-account.*\.json)$/i;
const risky = files.filter((f) => SECRETISH.test(f));
if (risky.length) throw new Error('refusing to send credential-like files: ' + risky.join(', ') + ' (ignore or move them)');
const current = snapshot(appDir, files);
const toShards = (light, dark) => [...light.map((flow) => ({ flow, pass: 'light' })), ...dark.map((flow) => ({ flow, pass: 'dark' }))];
const plan = {};
const covered = opts.unitCovered ? new Set(opts.unitCovered.split(',').filter(Boolean)) : null;
const decided = { skipped: [], noChange: true, deferred: [], iosWhy: '' };
// What each platform's plan was compared against (fileMapHash of its base; undefined = a full run, which proves everything).
// The last pass moves only while it still equals this, so a run that built on another run's pending content cannot move it
// when that run failed or has not finished.
const baseHash = {};
// A gate (--ios wait: land, store build) compares with the last pass only: a hung or killed background run cannot empty its plan.
const gate = opts.ios === 'wait';
for (const p of opts.platforms.split(',')) {
  if (opts.flows) plan[p] = toShards(opts.flows.split(','), opts.dark && opts.dark !== 'none' ? opts.dark.split(',') : []);
  else if (opts.changed) {
    const pending = p === 'ios' && !gate ? readPendingIos(appId) : null;
    const base = pending || readLastPass(appId, p);
    baseHash[p] = fileMapHash(base);
    const changes = changedSince(base, current);
    const split = splitByCoverage(flowMap, changes, flowNames, darkDefault, covered);
    const sel = { ...(p === 'ios' ? split.ios : split.android) };
    if (pending) sel.why += '; compared with the iOS run still in the background';
    if (opts.dark) sel.dark = opts.dark === 'none' ? [] : opts.dark.split(',');
    plan[p] = toShards(sel.light, sel.dark);
    if (changes === null || changes.length) decided.noChange = false;
    decided.skipped.push(...split.skipped);
    if (p === 'ios' && plan.ios.length) {
      const risk = iosRisk(flowMap, changes, appDir, opts.lang);
      decided.iosWhy = opts.iosWhen === 'risk' && opts.ios === 'background' ? risk : opts.lang === 'vi' ? 'bước đẩy/phát hành' : 'land/release step';
      if (opts.iosWhen === 'risk' && opts.ios === 'background' && !risk) { decided.deferred = plan.ios; plan.ios = []; }
    }
    log(p + ': ' + (plan[p].length ? plan[p].map((s) => (s.pass === 'dark' ? 'dark ' : '') + s.flow).join(', ') : 'nothing to run') + ' (' + sel.why.slice(0, 300) + ')');
  } else plan[p] = toShards(flowNames, opts.dark === 'none' ? [] : opts.dark ? opts.dark.split(',') : darkDefault);
}
const platforms = Object.keys(plan).filter((p) => plan[p].length);
if (opts.changed) {
  const names = (shards) => [...new Set(shards.map((x) => x.flow))];
  const d = describeDecision(opts.lang, {
    androidFlows: names(plan.android || []),
    ios: plan.ios?.length ? { mode: 'run', flows: names(plan.ios), why: decided.iosWhy, wait: gate } : decided.deferred.length ? { mode: 'defer', flows: names(decided.deferred) } : { mode: 'none', flows: [] },
    skipped: [...new Set(decided.skipped)], noChange: decided.noChange,
  });
  log(d.text);
  log('decision-code: ' + d.code);
}
if (opts.planOnly) { log('--plan-only: stopping before anything is packed or started'); process.exit(0); }
if (!platforms.length) { log('no flow covers what changed: nothing to run (' + Math.round((Date.now() - started) / 100) / 10 + ' s)'); process.exit(previousIosFailed ? 1 : 0); }

// The iOS lane (a Codemagic account or GitHub shards) is picked later, right before the build starts (after the wait for
// the lock, which can take minutes): until then iOS counts as a GitHub platform.
const cmConfigs = codemagicConfigs();
const force = parseIosOn(opts.iosOn);
if (force?.lane === 'codemagic' && !platforms.includes('ios')) log('--ios-on has no effect: no iOS flow to run');
if (force?.lane === 'codemagic' && platforms.includes('ios') && !cmConfigs.some((c) => !force.account || c.index === force.account)) {
  throw new Error('--ios-on ' + opts.iosOn + ' needs that Codemagic account (token and app id) in ' + kitDir());
}
let cmConf = null;
let ghPlatforms = platforms;
let ghShards = [];
let iosBackground = false;
const useLane = (conf) => {
  cmConf = conf;
  ghPlatforms = platforms.filter((p) => !(p === 'ios' && cmConf));
  ghShards = [...new Map(ghPlatforms.flatMap((p) => plan[p]).map((s) => [s.pass + s.flow, s])).values()];
  iosBackground = !!cmConf && opts.ios === 'background';
};
useLane(null);
// A snapshot says "everything that changed passed": only a --changed or full run, with the default dark pass, earns it.
const savesSnapshot = !opts.flows && !opts.dark;

const token = execFileSync('gh', ['auth', 'token', '--user', ACCOUNT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const env = { ...process.env, GH_TOKEN: token };
const gh = (args, o = {}) => execFileSync('gh', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...o });
// The key goes through stdin, never the command line (other processes and audit logs can read argv).
const setKey = (hex) => execFileSync('gh', ['secret', 'set', 'APP_QA_KEY', '-R', REPO], { env, input: hex, stdio: ['pipe', 'pipe', 'pipe'] });

// ---- one call at a time (they share APP_QA_KEY); leftovers of a killed caller are removed first. A background iOS
// build holds its release only until Codemagic has fetched it (about a minute; longer while Codemagic queues).
const ageMin = (t) => (Date.now() - Date.parse(t)) / 60000;
async function sweepAndLock() {
  for (let attempt = 0; ; attempt++) {
    const runs = JSON.parse(gh(['run', 'list', '-R', REPO, '-w', WORKFLOW, '-L', '50', '--json', 'databaseId,displayTitle,status,createdAt,updatedAt']));
    for (const r of runs) {
      if (r.status !== 'completed' && ageMin(r.createdAt) > 180) { try { gh(['run', 'cancel', String(r.databaseId), '-R', REPO]); log('cancelled abandoned run ' + r.displayTitle); } catch { /* already ending */ } }
      if (r.status === 'completed' && ageMin(r.updatedAt) > 30) { try { gh(['run', 'delete', String(r.databaseId), '-R', REPO]); log('deleted leftover run ' + r.displayTitle); } catch { /* gone */ } }
    }
    const active = runs.filter((r) => r.status !== 'completed' && ageMin(r.createdAt) <= 180).map((r) => r.displayTitle);
    // A release handed to a background iOS process (title ends in 'ios-background') needs no lock: iOS has its own key
    // copy on Codemagic and the process deletes it; only GitHub runs share APP_QA_KEY.
    const rels = JSON.parse(gh(['release', 'list', '-R', REPO, '-L', '100', '--json', 'tagName,createdAt,name'])).filter((x) => x.tagName.startsWith('app-qa-') && !(/ios-background$/.test(x.name || '') && ageMin(x.createdAt) <= 180));
    for (const r of rels.filter((x) => ageMin(x.createdAt) > 180)) { try { gh(['release', 'delete', r.tagName, '-R', REPO, '--cleanup-tag', '-y']); log('deleted leftover release ' + r.tagName); } catch { /* gone */ } }
    const held = [...active, ...rels.filter((x) => ageMin(x.createdAt) <= 180).map((x) => x.tagName)];
    if (!held.length) return;
    if (attempt >= 40) throw new Error('another app-qa call is still running (' + held.join(', ') + ')');
    if (attempt === 0) log('waiting for the previous app-qa call to free the repo (' + held.join(', ') + ')');
    await sleep(15000);
  }
}

const rid = 'aq-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + randomBytes(2).toString('hex');
const tag = 'app-qa-' + rid;
const outDir = path.resolve(opts.out || path.join(os.tmpdir(), rid));
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'app-qa-'));
fs.writeFileSync(path.join(work, 'list.txt'), files.join('\n') + '\n');
execFileSync(tarBin, ['-czf', path.join(work, 'app.tgz'), '-T', path.join(work, 'list.txt')], { cwd: appDir });
const key = randomBytes(32);
fs.writeFileSync(path.join(work, 'app.tgz.enc'), seal(key, fs.readFileSync(path.join(work, 'app.tgz'))));
fs.rmSync(path.join(work, 'app.tgz'));
log(files.length + ' files packed');

// ---- reuse an earlier release build when only JS changed
const fp = opts.full ? null : nativeFingerprint(appDir);
const sk = shellKey(fp, mediaHash(appDir, files));
const reuse = [];
for (const p of platforms) {
  const shell = findShell(appId, p, sk);
  if (!shell) continue;
  fs.writeFileSync(path.join(work, 'shell-' + p + '.tgz.enc'), seal(key, fs.readFileSync(shell)));
  reuse.push(p);
}
log(opts.full ? 'full native build (--full)' : !fp ? 'no Expo fingerprint (node_modules missing?): full native build'
  : reuse.length ? 'JS-only change: reusing the earlier build for ' + reuse.join(', ') + (reuse.length < platforms.length ? '; native build for the rest' : '')
  : 'native code or media changed since the last kept build: full native build');

const keepShell = (platform, tgz) => {
  const kept = sk && !reuse.includes(platform) ? storeShell(appId, platform, sk, tgz) : null;
  if (kept) log(platform + ': build kept for JS-only runs (' + Math.round(fs.statSync(kept).size / 1e6) + ' MB)');
};

let runId = null;
let dispatched = false;
let cmBuildId = null;
let handedOff = false;
let ghDoneFile = null;
let cm = null;
const findRun = () => JSON.parse(gh(['run', 'list', '-R', REPO, '-w', WORKFLOW, '-L', '20', '--json', 'databaseId,displayTitle'])).find((x) => x.displayTitle === rid)?.databaseId ?? null;
let cleaning = null;
function cleanup() {
  cleaning ??= (async () => {
    if (cmBuildId && !handedOff) { try { await cm.cancel(cmBuildId); log('Codemagic build cancelled'); } catch { /* finished or gone */ } }
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
    // The background iOS process deletes the release once Codemagic has fetched it.
    if (!handedOff) { try { gh(['release', 'delete', tag, '-R', REPO, '--cleanup-tag', '-y']); log('release deleted'); } catch { /* never created, or already gone */ } }
    try { setKey(randomBytes(32).toString('hex')); } catch (e) { log('WARNING: could not replace APP_QA_KEY: ' + String(e.stderr || e.message).slice(0, 150)); }
    fs.rmSync(work, { recursive: true, force: true });
    // The background iOS process may delete the release now.
    if (ghDoneFile) { try { fs.writeFileSync(ghDoneFile, ''); } catch { /* it waits, then gives up */ } }
  })();
  return cleaning;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { log('interrupted, cleaning up'); cleanup().finally(() => process.exit(2)); });

async function waitGithub() {
  let last = '';
  let apiErrors = 0;
  const deadline = Date.now() + 150 * 60000;
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
    const jobs = v.jobs.filter((j) => j.conclusion !== 'skipped');
    const line = jobs.map((j) => j.name + ':' + (j.conclusion || j.status) + (j.steps?.find((s) => s.status === 'in_progress') ? ' (' + j.steps.find((s) => s.status === 'in_progress').name + ')' : '')).join(' | ');
    if (line !== last) { log(line); last = line; }
    if (v.status === 'completed') {
      // Where the time went, per job and step (the run itself is deleted afterwards).
      const t0 = Date.parse(jobs.map((j) => j.startedAt).filter(Boolean).sort()[0] || 0);
      const mins = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 6000) / 10;
      for (const j of jobs) if (j.startedAt && j.completedAt) log('time ' + j.name + ': starts +' + mins(new Date(t0).toISOString(), j.startedAt) + ' min, takes ' + mins(j.startedAt, j.completedAt) + ' min');
      const steps = jobs.flatMap((j) => (j.steps || []).filter((x) => x.startedAt && x.completedAt && !x.startedAt.startsWith('0001'))
        .map((x) => j.name + ' | ' + x.name + ' | ' + Math.round((Date.parse(x.completedAt) - Date.parse(x.startedAt)) / 1000) + ' s'));
      fs.writeFileSync(path.join(outDir, 'timings.txt'), steps.join('\n') + '\n');
      if (v.conclusion !== 'success') {
        for (const j of jobs.filter((x) => x.conclusion !== 'success')) {
          try { for (const a of JSON.parse(gh(['api', 'repos/' + REPO + '/check-runs/' + j.databaseId + '/annotations']))) if (!/Node\.js 20|capacity constraints/.test(a.message)) log(j.name + ': ' + String(a.message).slice(0, 300)); } catch { /* none */ }
        }
        try { fs.writeFileSync(path.join(outDir, 'failed.log'), gh(['run', 'view', String(runId), '-R', REPO, '--log-failed'])); } catch { /* none */ }
      }
      gh(['run', 'download', String(runId), '-R', REPO, '-D', outDir]);
      return;
    }
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(10000);
  }
}

let code = 0;
try {
  await sweepAndLock();
  if (platforms.includes('ios')) {
    const lane = await chooseIosLane({ configs: cmConfigs, force, log, rid });
    log('ios lane: ' + (lane.conf ? 'Codemagic ' + lane.conf.label : 'GitHub macOS') + ' - ' + lane.why);
    useLane(lane.conf);
    if (lane.conf) cm = codemagic(lane.conf, log);
  }
  setKey(key.toString('hex'));
  gh(['release', 'create', tag, path.join(work, 'app.tgz.enc'), ...reuse.map((p) => path.join(work, 'shell-' + p + '.tgz.enc')), '-R', REPO, '--title', tag, '--notes', 'Temporary encrypted input of an app-qa run; deleted when the run ends.', '--prerelease']);
  if (cm) {
    cmBuildId = await cm.start({ ASSET_TAG: tag, APP_ID: appId, APP_QA_KEY: key.toString('hex'), REUSE: reuse.includes('ios') ? 'ios' : '', SHARDS: JSON.stringify(plan.ios) });
    log('ios on Codemagic M2' + (iosBackground ? ' (background)' : '') + ': https://codemagic.io/app/' + cmConf.appId + '/build/' + cmBuildId);
    if (iosBackground) {
      // The detached process owns the iOS half from here: results, kept build, release deletion, the iOS snapshot.
      const stateFile = path.join(kitDir(), 'bg-' + rid + '.json');
      fs.mkdirSync(kitDir(), { recursive: true });
      ghDoneFile = path.join(kitDir(), 'gh-done-' + rid);
      if (!ghPlatforms.length) fs.writeFileSync(ghDoneFile, '');
      fs.writeFileSync(stateFile, JSON.stringify({ buildId: cmBuildId, keyHex: key.toString('hex'), tag, repo: REPO, account: ACCOUNT, outDir: path.join(kitDir(), 'ios-results', rid),
        cmAccount: cmConf.index, cmAppId: cmConf.appId, appId, rid, baseHash: baseHash.ios, shellKey: sk, reused: reuse.includes('ios'), shards: plan.ios, snapshot: savesSnapshot ? current : null, ghDoneFile }), { mode: 0o600 });
      const child = spawn(process.execPath, [path.join(import.meta.dirname, 'app-qa-ios-bg.mjs'), stateFile], { detached: true, stdio: 'ignore', windowsHide: true });
      await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
      child.unref();
      handedOff = true;
      if (savesSnapshot) writePendingIos(appId, current, rid);
      try { gh(['release', 'edit', tag, '-R', REPO, '--title', tag + ' ios-background']); } catch { /* the lock then waits for it */ }
      log('iOS continues in the background; its result: ' + path.join(kitDir(), 'ios-results', rid) + ' (printed by the next app-qa call)');
    }
  }
  if (ghPlatforms.length) {
    dispatched = true;
    gh(['workflow', 'run', WORKFLOW, '-R', REPO, '-f', 'request_id=' + rid, '-f', 'asset_tag=' + tag, '-f', 'platforms=' + ghPlatforms.join(','), '-f', 'app_id=' + appId,
      '-f', 'ios_runner=' + opts.iosRunner, '-f', 'shards=' + JSON.stringify(ghShards), '-f', 'reuse=' + reuse.filter((p) => ghPlatforms.includes(p)).join(',')]);
    for (let t = 0; !runId && t < 24; t++) { await sleep(3000); runId = findRun(); }
    if (!runId) throw new Error('run not found');
    log('run ' + rid + ': https://github.com/' + REPO + '/actions/runs/' + runId);
    await waitGithub();
  }
  if (cm && !iosBackground) {
    const build = await cm.wait(cmBuildId);
    handedOff = true; // finished: nothing to cancel
    await cm.download(build, work, outDir);
  }
  // Artifacts are sealed with this run's key: open them here.
  openArtifacts({ outDir, key, work, log, onApp: keepShell });
  for (const p of platforms.filter((x) => !(x === 'ios' && iosBackground))) {
    const ok = summarize({ outDir, platform: p, shards: plan[p], log });
    if (ok && savesSnapshot) { if (!moveLastPass(appId, p, current, baseHash[p])) log(p + ': last pass not moved (another run changed it meanwhile); the next --changed run covers the difference'); }
    else code = 1;
  }
  log('results: ' + outDir + ' (' + Math.round((Date.now() - started) / 6000) / 10 + ' min)');
} catch (e) {
  log('error: ' + e.message);
  code = 2;
} finally {
  await cleanup();
}
if (previousIosFailed && code === 0) { log('exit 1: the background iOS run of the previous call failed (above)'); code = 1; }
process.exit(code);
