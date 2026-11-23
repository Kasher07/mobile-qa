// Which runner takes the iOS half of an app-qa call: one of the Codemagic accounts (Mac mini M2, all flows in one
// simulator session) or GitHub macOS shards (free on this public repo, but ~9 min of Mac setup per flow).
//
// Rule (auto): ask every Codemagic account for its builds (GET /builds?appId=...). An account is busy while it has a
// build that is not in a final state (a free personal plan runs one build at a time), or while an earlier app-qa call
// on this machine claimed it less than 3 minutes ago (the build list can lag behind a just-started build). Minutes used
// = build minutes started this calendar month (UTC), a running build counted up to now. Take the idle account with the
// most minutes left, if it has at least 45 left (max_build_duration is 40); ties go to the lower number. Every account
// busy, nearly out of minutes or unreachable: GitHub macOS shards, never a queue. --ios-on forces a lane.
import fs from 'node:fs';
import path from 'node:path';

import { CM_FINAL, codemagic, kitDir } from './app-qa-lib.mjs';

export const MONTHLY_MINUTES = 500; // Codemagic free personal plan
export const MIN_LEFT = 45; // a build may run 40 min (codemagic.yaml max_build_duration) plus rounding
export const STALE_MS = 4 * 3600e3; // a not-final build created longer ago than this is a ghost, not a queue
export const CLAIM_MS = 3 * 60e3;

export const monthStartMs = (now) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };

/**
 * builds: Codemagic build objects ({ status, createdAt, startedAt, finishedAt }). Returns { busy, running, minutes }:
 * busy = some not-final build was created within STALE_MS; minutes = whole minutes (rounded up per build) between each
 * build's start and its end (now for a running one), counting only the part inside the current UTC month.
 */
export function usage(builds, now = Date.now()) {
  const monthStart = monthStartMs(now);
  let minutes = 0;
  let running = null;
  for (const b of builds || []) {
    const final = CM_FINAL.includes(b.status);
    if (!final && now - Date.parse(b.createdAt) <= STALE_MS) running ??= b;
    if (!b.startedAt) continue;
    const start = Math.max(Date.parse(b.startedAt), monthStart);
    const end = b.finishedAt ? Date.parse(b.finishedAt) : final ? start : now;
    if (end > start) minutes += Math.ceil((end - start) / 60000);
  }
  return { busy: !!running, running: running ? { index: running.index, status: running.status } : null, minutes };
}

/** "--ios-on" value to a force: null (auto), { lane: 'github' } or { lane: 'codemagic', account: n | null }. */
export function parseIosOn(v) {
  if (v == null) return null;
  if (v === 'github') return { lane: 'github' };
  const m = /^codemagic(?::(\d+))?$/.exec(v);
  if (!m) throw new Error('--ios-on must be codemagic, codemagic:<account number> or github');
  return { lane: 'codemagic', account: m[1] ? Number(m[1]) : null };
}

const left = (a) => a.quota - a.minutes;
/** "#1 busy (build 10 building), 123/500 min" */
export const describeAccount = (a) => a.label + ' ' + (a.error ? 'unreachable (' + a.error + ')' : (a.busy ? 'busy' + (a.running ? ' (build ' + a.running.index + ' ' + a.running.status + ')' : ' (claimed just now)') : 'idle') + ', ' + a.minutes + '/' + a.quota + ' min used');

/**
 * accounts: [{ index, label, busy, running, minutes, quota, error }] (error = the API could not be read).
 * Returns { lane: 'codemagic', account: <entry>, why } or { lane: 'github', why }.
 */
export function pickLane(accounts, force = null, minLeft = MIN_LEFT) {
  const pool = accounts.map(describeAccount).join(' | ') || 'no Codemagic account configured';
  if (force?.lane === 'github') return { lane: 'github', why: '--ios-on github (pool: ' + pool + ')' };
  if (force) {
    // Forced Codemagic: the named account, else the best one even if it has to queue (the caller asked for Codemagic).
    const named = force.account ? accounts.find((a) => a.index === force.account) : null;
    if (force.account && !named) throw new Error('--ios-on codemagic:' + force.account + ' but that account is not configured');
    const best = named || [...accounts].sort((a, b) => Number(a.busy || !!a.error) - Number(b.busy || !!b.error) || left(b) - left(a) || a.index - b.index)[0];
    if (!best) throw new Error('--ios-on codemagic needs a Codemagic token and app id in ' + kitDir());
    return { lane: 'codemagic', account: best, why: '--ios-on ' + (force.account ? 'codemagic:' + force.account : 'codemagic') + ' picked ' + best.label + ' (pool: ' + pool + ')' };
  }
  const usable = accounts.filter((a) => !a.error && !a.busy && left(a) >= minLeft);
  if (usable.length) {
    const best = [...usable].sort((a, b) => left(b) - left(a) || a.index - b.index)[0];
    return { lane: 'codemagic', account: best, why: best.label + ' is idle with the most minutes left, ' + left(best) + ' (pool: ' + pool + ')' };
  }
  if (!accounts.length) return { lane: 'github', why: 'no Codemagic account configured' };
  const reasons = accounts.map((a) => a.label + (a.error ? ' unreachable' : a.busy ? ' busy' : ' only ' + left(a) + ' min left')).join(', ');
  return { lane: 'github', why: 'GitHub macOS shards instead of queueing: ' + reasons + ' (pool: ' + pool + ')' };
}

// ---- claims: accounts an earlier call on this machine picked a moment ago (pool-claims.json in the kit folder)
const claimFile = () => path.join(kitDir(), 'pool-claims.json');
export function readClaims(now = Date.now()) {
  try { return JSON.parse(fs.readFileSync(claimFile(), 'utf8')).filter((c) => now - Date.parse(c.at) < CLAIM_MS); } catch { return []; }
}
export function writeClaim(index, rid, now = Date.now()) {
  try {
    fs.mkdirSync(kitDir(), { recursive: true });
    fs.writeFileSync(claimFile(), JSON.stringify([...readClaims(now), { account: index, rid, at: new Date(now).toISOString() }]));
  } catch { /* the pick still stands; only the double-claim guard is lost */ }
}

/** Reads every account (in parallel; a failing one is marked, not fatal) and applies pickLane. */
export async function chooseIosLane({ configs, force, log, now = Date.now(), quota = Number(process.env.APP_QA_CM_MONTHLY_MINUTES) || MONTHLY_MINUTES, api = (c) => codemagic(c, log) }) {
  const claims = readClaims(now);
  const accounts = await Promise.all(configs.map(async (c) => {
    const base = { index: c.index, label: c.label, quota: c.monthlyMinutes || quota };
    try {
      const u = usage(await api(c).listBuilds({ sinceMs: monthStartMs(now) }), now);
      const claimed = claims.some((x) => x.account === c.index);
      return { ...base, ...u, busy: u.busy || claimed };
    } catch (e) { return { ...base, busy: false, running: null, minutes: 0, error: String(e.message).replace(/\s+/g, ' ').slice(0, 80) }; }
  }));
  const pick = pickLane(accounts, force);
  return { ...pick, conf: pick.account ? configs.find((c) => c.index === pick.account.index) : null };
}
