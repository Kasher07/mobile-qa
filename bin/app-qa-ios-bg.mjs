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
function deleteRelease() {
  if (releaseGone) return;
  releaseGone = true;
  try {
    const token = execFileSync('gh', ['auth', 'token', '--user', st.account], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    execFileSync('gh', ['release', 'delete', st.tag, '-R', st.repo, '--cleanup-tag', '-y'], { env: { ...process.env, GH_TOKEN: token }, stdio: 'ignore' });
    log('release deleted');
  } catch { log('release already gone, or the next app-qa call removes it'); }
}

let ok = false;
try {
  const cm = codemagic(codemagicConfig(), log);
  const build = await cm.wait(st.buildId, { onFetched: deleteRelease });
  await cm.download(build, work, st.outDir);
  openArtifacts({ outDir: st.outDir, key, work, log, onApp: (platform, tgz) => {
    const kept = st.shellKey && !st.reused ? storeShell(st.appId, platform, st.shellKey, tgz) : null;
    if (kept) log(platform + ': build kept for JS-only runs');
  } });
  ok = summarize({ outDir: st.outDir, platform: 'ios', shards: st.shards, log });
  if (ok) writeLastPass(st.appId, 'ios', st.snapshot);
} catch (e) {
  log('error: ' + e.message);
} finally {
  deleteRelease();
  fs.rmSync(work, { recursive: true, force: true });
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => /ios\/(light|dark)|no results|error/.test(l)) : [];
  fs.writeFileSync(resultFile, JSON.stringify({ at: new Date().toISOString(), ok, outDir: st.outDir, flows: st.shards, lines, seen: false }, null, 1));
  log('iOS ' + (ok ? 'passed' : 'FAILED') + ' (results: ' + st.outDir + ')');
}
