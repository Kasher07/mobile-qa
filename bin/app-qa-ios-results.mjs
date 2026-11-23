// Results of background iOS runs, one file per run so a failure nobody has read yet is never overwritten by a later run:
// ios-result-<appId>-<run id>.json in the kit folder, written by bin/app-qa-ios-bg.mjs, reported (every unseen one) and
// removed by the next bin/app-qa.mjs call. The older single last-ios-<appId>.json ({ ..., seen }) is still read as one entry.
import fs from 'node:fs';
import path from 'node:path';

import { kitDir } from './app-qa-lib.mjs';

const legacyFile = (appId) => path.join(kitDir(), 'last-ios-' + appId + '.json');
const runFile = (appId, rid) => path.join(kitDir(), 'ios-result-' + appId + '-' + rid + '.json');

export function writeIosResult(appId, rid, rec) {
  fs.mkdirSync(kitDir(), { recursive: true });
  fs.writeFileSync(runFile(appId, rid), JSON.stringify({ ...rec, rid, seen: false }, null, 1));
}

/** Every result not reported yet, oldest first: [{ file, legacy, rec }]. */
export function readUnseenIosResults(appId) {
  const out = [];
  const read = (file, legacy) => { try { const rec = JSON.parse(fs.readFileSync(file, 'utf8')); if (!rec.seen) out.push({ file, legacy, rec }); } catch { /* none, or half-written */ } };
  read(legacyFile(appId), true);
  let names = [];
  try { names = fs.readdirSync(kitDir()); } catch { /* no kit folder */ }
  for (const n of names) if (n.startsWith('ios-result-' + appId + '-') && n.endsWith('.json')) read(path.join(kitDir(), n), false);
  return out.sort((a, b) => Date.parse(a.rec.at) - Date.parse(b.rec.at));
}

export function markIosResultSeen(entry) {
  if (entry.legacy) fs.writeFileSync(entry.file, JSON.stringify({ ...entry.rec, seen: true }, null, 1));
  else fs.rmSync(entry.file, { force: true });
}
