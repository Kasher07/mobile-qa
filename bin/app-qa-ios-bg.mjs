#!/usr/bin/env node
// iOS in the background (app-qa --ios background): started detached by bin/app-qa.mjs once the Codemagic build is
// queued. Deletes the temporary GitHub release as soon as Codemagic has fetched it, waits for the build, opens the
// results, keeps a fresh native build for JS-only runs, and records the outcome for the next app-qa call
// (last-ios-<appId>.json; the iOS last-pass snapshot moves only when every iOS flow passed).
// Usage: node bin/app-qa-ios-bg.mjs <state.json> (written by app-qa.mjs, readable only by this user, deleted here).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codemagic, codemagicConfig, kitDir, makeLog, openArtifacts, summarize } from './app-qa-lib.mjs';
import { writeLastPass } from './app-qa-select.mjs';
import { storeShell } from './app-qa-shell.mjs';

const stateFile = process.argv[2];
const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
fs.rmSync(stateFile, { force: true });
const key = Buffer.from(st.keyHex, 'hex');
fs.mkdirSync(st.outDir, { recursive: true });
const logFile = path.join(st.outDir, 'ios-background.log');
const log = makeLog('app-qa ios', logFile);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'app-qa-ios-'));
const resultFile = path.join(kitDir(), 'last-ios-' + st.appId + '.json');
let releaseGone = false;
// The release also feeds the Android jobs of the same call: it goes only once Codemagic has fetched it AND the caller
// has finished with GitHub (it writes ghDoneFile in its cleanup).
const ghDone = () => !st.ghDoneFile || fs.existsSync(st.ghDoneFile);
function deleteRelease() {
  if (releaseGone || !ghDone()) return;
  try {
    // Pipes, not 'ignore': a detached process has no console, and gh needs its streams (2026-11-23).
    const run = (args, env) => execFileSync('gh', args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const token = run(['auth', 'token', '--user', st.account]).trim();
    run(['release', 'delete', st.tag, '-R', st.repo, '--cleanup-tag', '-y'], { ...process.env, GH_TOKEN: token });
    releaseGone = true;
    log('release deleted');
  } catch (e) {
    const why = String(e.stderr || e.message).split('\n')[0].slice(0, 200);
    if (/not found|404/i.test(why)) { releaseGone = true; return; }
    log('could not delete the release yet (' + why + ')');
  }
}

let ok = false;
let lines = [];
try {
  const cm = codemagic(codemagicConfig(), log);
  const build = await cm.wait(st.buildId, { onFetched: deleteRelease });
  await cm.download(build, work, st.outDir);
  openArtifacts({ outDir: st.outDir, key, work, log, onApp: (platform, tgz) => {
    const kept = st.shellKey && !st.reused ? storeShell(st.appId, platform, st.shellKey, tgz) : null;
    if (kept) log(platform + ': build kept for JS-only runs');
  } });
  ok = summarize({ outDir: st.outDir, platform: 'ios', shards: st.shards, log });
  if (ok && st.snapshot) writeLastPass(st.appId, 'ios', st.snapshot);
} catch (e) {
  log('error: ' + e.message);
} finally {
  try { lines = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /ios\/(light|dark)|no results|error/.test(l)); } catch { /* none */ }
  fs.writeFileSync(resultFile, JSON.stringify({ at: new Date().toISOString(), ok, outDir: st.outDir, flows: st.shards, lines, seen: false }, null, 1));
  log('iOS ' + (ok ? 'passed' : 'FAILED') + ' (results: ' + st.outDir + ')');
  fs.rmSync(work, { recursive: true, force: true });
  // Wait (at most 30 min) for the caller to be done with GitHub before the release goes; the next call sweeps it
  // after 3 hours otherwise.
  for (let i = 0; i < 120 && !releaseGone; i++) {
    deleteRelease();
    if (!releaseGone) await new Promise((r) => setTimeout(r, 15000));
  }
  if (st.ghDoneFile) fs.rmSync(st.ghDoneFile, { force: true });
}
