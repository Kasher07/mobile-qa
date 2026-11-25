// Private mode of mobile-qa: real-phone screenshots of the signed-in pages of a kit-qa qa-agent site.
//   kit-qa exec <site> -- node bin/mobile-qa.mjs --private /#sales /#inventory [--platforms ios,android]
// The repo is public, so: the job (origin, paths, the session cookies of that host only) is sealed with a fresh AES-256-GCM
// key kept in the repo secret PRIVATE_QA_KEY and only ciphertext travels (workflow input); the runner seals every result
// before upload; this client unseals locally, deletes the run and replaces the secret with random bytes. QA_AGENT_KEY never
// leaves KIT: only the 2 h session cookies kit-qa already holds are sent.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportFlows } from '../runner/flows.mjs';
import { privateFlows, buildJob, sealJob, unseal, resultAad, untrusted, leakVerdict, gitBashPaths, rawArtifactLeaks } from '../runner/private.mjs';

const REPO = process.env.MOBILE_QA_REPO || 'Kasher07/mobile-qa';
const ACCOUNT = process.env.MOBILE_QA_ACCOUNT || 'Kasher07';
const REF = process.env.MOBILE_QA_REF || 'main'; // the branch whose workflow runs (set to test a branch before it is merged)
const WORKFLOW = 'mobile-qa.yml';
const SECRET = 'PRIVATE_QA_KEY';
const DEADLINE_MS = 75 * 60000;
export const DEFAULT_OUT = process.env.MOBILE_QA_PRIVATE_OUT || 'D:/Kit/tmp_research/mobile-qa-private';
const LOCK_FILE = process.env.MOBILE_QA_LOCK || path.join(os.tmpdir(), 'mobile-qa-private.lock'); // the env names are for the tool's own tests
const LOCK_MAX_AGE_MS = DEADLINE_MS + 15 * 60000; // call deadline + cleanup time: an older lock is stale whatever its PID
// gh is replaced by a stub script in the tool's own tests (MOBILE_QA_GH_SCRIPT); never set it otherwise.
const ghBin = (args) => (process.env.MOBILE_QA_GH_SCRIPT ? [process.execPath, [process.env.MOBILE_QA_GH_SCRIPT, ...args]] : ['gh', args]);
const runGh = (args, o) => { const [c, a] = ghBin(args); return execFileSync(c, a, o); };
const log = (s) => console.log('[mobile-qa:private] ' + s);
const TIME_SCALE = process.env.MOBILE_QA_TEST_FAST ? 0.005 : 1; // tests only
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * TIME_SCALE));
const ageMin = (t) => (Date.now() - Date.parse(t)) / 60000;

// What the leak scan looks for in text.
export function leakScan(text, needles) {
  const hits = {};
  for (const [name, value] of Object.entries(needles)) {
    const list = [].concat(value).filter((v) => v && v.length >= 6);
    hits[name] = list.filter((v) => text.includes(v) || text.includes(encodeURIComponent(v))).length;
  }
  return hits;
}

// ---- local lock: two private calls on this machine cannot overlap (they share one secret). A lock of a dead PID is taken over.
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
export function acquireLock(file, { pid = process.pid, alive = pidAlive, now = Date.now, maxAgeMs = LOCK_MAX_AGE_MS } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      let mtime = now();
      try {
        mtime = fs.statSync(file).mtimeMs;
        holder = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch { /* unreadable: maybe being written right now */ }
      const age = holder && holder.start ? now() - Date.parse(holder.start) : now() - mtime;
      const stale = holder && holder.pid ? !alive(holder.pid) || age > maxAgeMs : age > Math.min(maxAgeMs, 10000);
      if (!stale) {
        if (holder && holder.pid) throw new Error('another private call is running on this machine (pid ' + holder.pid + ', started ' + holder.start + ')');
        await_(50);
        continue;
      }
      // Take over atomically: rename moves the stale lock away for exactly one caller; the loser retries.
      try {
        const gone = file + '.stale-' + pid + '-' + attempt + '-' + now();
        fs.renameSync(file, gone);
        fs.rmSync(gone, { force: true });
      } catch { /* somebody else took it over first */ }
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid, start: new Date(now()).toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
    return () => {
      try {
        if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file, { force: true });
      } catch { /* gone */ }
    };
  }
  throw new Error('could not take the private-call lock');
}
function await_(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* short spin: a lock being written */ }
}

// ---- all pq- runs of the workflow, over enough pages (not just the newest 50)
export async function listPrivateRuns(fetchPage, maxPages = 10) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const runs = await fetchPage(page);
    if (!runs.length) break;
    out.push(...runs.filter((r) => /^pq-/.test(r.displayTitle || '')));
    if (runs.length < 100) break;
  }
  return out;
}

// ---- cleanup: stops any further dispatch, replaces the secret FIRST, then cancels and deletes this call's runs, including a
// run GitHub accepted but the client lost track of (found by the call's base id in the run title).
export function makeCleaner(d) {
  let stopping = false;
  let cleaning = null;
  let rotationFailed = false;
  const wait = d.sleep || sleep;
  return {
    assertRunning() {
      if (stopping) throw new Error('cleaning up: no new run is dispatched');
    },
    isStopping: () => stopping,
    rotationFailed: () => rotationFailed,
    cleanup() {
      stopping = true;
      cleaning ??= (async () => {
        if (d.secretSet()) rotationFailed = (await d.replaceSecret()) === false;
        const seen = new Set();
        const handle = async (id, status) => {
          if (seen.has(id)) return;
          seen.add(id);
          if (status !== 'completed') await d.cancel(id);
          await d.del(id);
        };
        for (const a of d.tracked()) if (!a.deleted) await handle(a.id, a.status);
        // A dispatch GitHub accepted but this client lost shows up under the call's base id, possibly late: look twice.
        for (let pass = 0; pass < 2; pass++) {
          if (pass) await wait(10000);
          try {
            for (const r of await d.listRuns()) if ((r.displayTitle || '').startsWith(d.baseId)) await handle(r.databaseId, r.status);
          } catch (e) {
            d.log('could not look for lost runs: ' + String(e.message).slice(0, 100));
          }
        }
      })();
      return cleaning;
    },
  };
}

export async function runPrivate(opts, deps) {
  const { verdict, starvedAction, iosPools, InputError } = deps;
  let built;
  try {
    let flowsWire = null;
    if (opts.steps) {
      let doc;
      try {
        const raw = fs.readFileSync(opts.steps, 'utf8');
        if (raw.length > 80000) throw new Error('the steps file is too large');
        doc = JSON.parse(raw);
      } catch (e) {
        throw new Error('cannot use the steps file: ' + String(e.message).slice(0, 100));
      }
      if (opts.allowWrites !== null && doc && typeof doc === 'object') doc.allowWrites = String(opts.allowWrites);
      flowsWire = JSON.parse(privateFlows(process.env.KITQA_BASE, doc).wireJson); // the steps travel inside the sealed job
    }
    built = buildJob(process.env, process.platform === 'win32' ? gitBashPaths(opts.urls) : opts.urls, undefined, flowsWire);
  } catch (e) {
    throw new InputError(e.message);
  }
  const { job, host } = built;
  let token;
  try {
    token = runGh(['auth', 'token', '--user', ACCOUNT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new InputError('gh could not give the ' + ACCOUNT + ' token (gh auth login --web --scopes workflow, then switch back to your account)');
  }
  const env = { ...process.env, GH_TOKEN: token };
  delete env.KITQA_STORAGE_STATE;
  const gh = (args, o = {}) => runGh(args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...o });
  // The key goes through stdin, never the command line.
  const setKey = (hex) => runGh(['secret', 'set', SECRET, '-R', REPO], { env, input: hex, stdio: ['pipe', 'pipe', 'pipe'] });
  const secretTime = () => {
    try {
      return JSON.parse(gh(['secret', 'list', '-R', REPO, '--json', 'name,updatedAt'])).find((s) => s.name === SECRET)?.updatedAt || '?';
    } catch {
      return '?';
    }
  };
  const norm = (x) => ({ databaseId: x.id, displayTitle: x.display_title, status: x.status, createdAt: x.created_at, updatedAt: x.updated_at, runStartedAt: x.run_started_at });
  const listRuns = () => listPrivateRuns((page) => JSON.parse(gh(['api', 'repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/runs?event=workflow_dispatch&per_page=100&page=' + page])).workflow_runs.map(norm));

  let release = null;
  try {
    release = acquireLock(LOCK_FILE);
  } catch (e) {
    throw new InputError(e.message);
  }
  // Everything after the lock sits in this try: whatever throws, the lock is released (release is idempotent).
  try {
  const keyHex = randomBytes(32).toString('hex');
  const baseId = 'pq-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '-' + randomBytes(2).toString('hex');
  const outDir = path.join(path.resolve(opts.out || DEFAULT_OUT), baseId);
  fs.mkdirSync(outDir, { recursive: true });
  const needles = { host: [host], cookie: job.cookies.map((c) => c.value), key: [keyHex] };
  const attempts = [];
  let secretSet = false;
  let leak = false;

  async function replaceSecret() {
    const before = secretTime();
    try {
      setKey(randomBytes(32).toString('hex'));
      log('secret replaced with random bytes (updated ' + before + ' -> ' + secretTime() + ')');
      return true;
    } catch (e) {
      log('SECRET NOT ROTATED: could not replace ' + SECRET + ' (' + String(e.stderr || e.message).slice(0, 150) + '); replace it by hand: gh secret set ' + SECRET + ' -R ' + REPO);
      return false;
    }
  }
  const cleaner = makeCleaner({
    log,
    baseId,
    secretSet: () => secretSet,
    replaceSecret,
    tracked: () => attempts,
    listRuns,
    cancel: async (id) => {
      try { gh(['run', 'cancel', String(id), '-R', REPO]); } catch { /* ending */ }
      for (let t = 0; t < 24; t++) {
        await sleep(5000);
        try { if (JSON.parse(gh(['run', 'view', String(id), '-R', REPO, '--json', 'status'])).status === 'completed') break; } catch { break; }
      }
    },
    del: async (id) => {
      try {
        gh(['run', 'delete', String(id), '-R', REPO]);
        const a = attempts.find((x) => x.id === id);
        if (a) a.deleted = true;
      } catch {
        log('could not delete a run; the next private call sweeps it: https://github.com/' + REPO + '/actions/runs/' + id);
      }
    },
  });
  const cleanup = () => cleaner.cleanup();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { log('interrupted, cleaning up'); cleanup().finally(() => { release(); process.exit(2); }); });

  // ---- leftovers of a killed caller (any age beyond the thresholds), over all pages
  const sweepLeftovers = async () => {
    let stale = false;
    const all = await listRuns();
    for (const r of all) {
      if (r.status !== 'completed' && ageMin(r.createdAt) > 180) {
        try { gh(['run', 'cancel', String(r.databaseId), '-R', REPO]); log('cancelled abandoned run'); stale = true; } catch { /* ending */ }
      } else if (r.status === 'completed' && ageMin(r.updatedAt) > 30) {
        try { gh(['run', 'delete', String(r.databaseId), '-R', REPO]); log('deleted a leftover run'); stale = true; } catch { /* gone */ }
      }
    }
    const active = all.filter((r) => r.status !== 'completed' && ageMin(r.createdAt) <= 180);
    if (active.length) throw new InputError('another private run is active; try again when it ends');
    if (stale) { try { setKey(randomBytes(32).toString('hex')); log('secret replaced after leftovers'); } catch { /* set below */ } }
  };

  async function dispatch(platforms, pool, suffix, dir) {
    cleaner.assertRunning();
    const rid = baseId + suffix;
    const inputs = { urls: 'private', platforms, request_id: rid, max_segments: String(opts.segments), ios_device: opts.iosDevice, ios_runner: iosPools[pool], ios_mode: opts.iosMode, private_job: sealJob(job, keyHex, rid) };
    gh(['workflow', 'run', WORKFLOW, '-R', REPO, '--ref', REF, '--json'], { input: JSON.stringify(inputs) });
    let id = null;
    for (let t = 0; !id && t < 24; t++) {
      cleaner.assertRunning();
      await sleep(5000);
      id = (await listRuns()).find((r) => r.displayTitle === rid)?.databaseId ?? null;
    }
    if (!id) throw new Error('could not find the run of ' + rid);
    const a = { rid, id, platforms, pool, dir, status: 'queued', conclusion: null, deleted: false, reruns: 0, finished: false, replaced: false, ok: false };
    attempts.push(a);
    log('run ' + rid + ' -> https://github.com/' + REPO + '/actions/runs/' + id + ' (' + job.paths.length + ' pages, ' + platforms + ')');
    return a;
  }

  // Downloads the sealed artifacts, unseals them here, scans the run log and the raw artifact for leaks.
  function collect(a) {
    fs.mkdirSync(a.dir, { recursive: true });
    const raw = path.join(a.dir, 'raw');
    try {
      gh(['run', 'download', String(a.id), '-R', REPO, '-D', raw]);
    } catch (e) {
      log(a.rid + ': download failed: ' + String(e.stderr || e.message).split('\n')[0].slice(0, 160));
    }
    let rawBytes = 0;
    const rawList = [];
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const buf = fs.readFileSync(p);
          rawBytes += buf.length;
          rawList.push({ name: e.name, buf });
        }
      }
    };
    walk(raw);
    const rawFiles = rawList.length;
    const rawOther = rawList.filter((f) => !f.name.endsWith('.enc')).length;
    const rawLeak = rawArtifactLeaks(rawList, [...needles.host, ...needles.cookie]);
    log(a.rid + ': raw artifact: ' + rawFiles + ' file(s), ' + rawBytes + ' bytes, ' + rawOther + ' not .enc, ' + rawLeak + ' readable marker(s)');
    let got = 0;
    for (const p of a.platforms.split(',')) {
      const f = path.join(raw, p, p + '.enc');
      if (!fs.existsSync(f)) continue;
      const tgz = path.join(a.dir, p + '.tgz');
      try {
        fs.writeFileSync(tgz, unseal(fs.readFileSync(f), keyHex, resultAad(a.rid, p)));
        fs.mkdirSync(path.join(a.dir, p), { recursive: true });
        execFileSync('tar', ['-xzf', p + '.tgz', '-C', p], { cwd: a.dir, stdio: ['ignore', 'pipe', 'pipe'] });
        got += fs.existsSync(path.join(a.dir, p, 'results.json')) ? 1 : 0;
      } catch (e) {
        log(a.rid + ': could not unseal ' + p + ': ' + String(e.message).slice(0, 100));
      } finally {
        fs.rmSync(tgz, { force: true });
      }
    }
    fs.rmSync(raw, { recursive: true, force: true });
    let logHost = 0;
    let logScanned = false;
    try {
      const text = gh(['run', 'view', String(a.id), '-R', REPO, '--log']);
      logHost = leakScan(text, { host: needles.host }).host;
      logScanned = true;
      log(a.rid + ': run log checked (' + text.split('\n').length + ' lines): hostname ' + logHost + ' occurrence(s)');
    } catch (e) {
      log(a.rid + ': run log could not be read: ' + String(e.stderr || e.message).split('\n')[0].slice(0, 120));
    }
    const v = leakVerdict({ logHost, rawLeak, logScanned });
    for (const l of v.lines) log(a.rid + ': ' + l);
    if (v.fail) {
      leak = true;
      log('WARNING: LEAK DETECTED, treat this run as exposed: rotate the QA session and the secret, and look at the run above');
    }
    return got === a.platforms.split(',').length;
  }

  let code = 2;
  try {
    await sweepLeftovers();
    secretSet = true; // before the call: a failure half-way must still end with the secret replaced
    setKey(keyHex);
    await dispatch(opts.platforms, 0, '', outDir);
    const t0 = Date.now();
    await sleep(30000);
    let apiErrors = 0;
    while (attempts.some((a) => !a.finished)) {
      cleaner.assertRunning();
      if (Date.now() - t0 > DEADLINE_MS) { log('timed out'); throw new Error('timed out'); }
      for (const a of attempts.filter((x) => !x.finished)) {
        let v;
        try {
          v = JSON.parse(gh(['run', 'view', String(a.id), '-R', REPO, '--json', 'status,conclusion,attempt,jobs']));
          apiErrors = 0;
        } catch (e) {
          if (++apiErrors > 20) throw e;
          await sleep(30000);
          continue;
        }
        if ((v.attempt || 1) < (a.minAttempt || 1)) continue;
        if (v.status !== a.status) log(a.rid + ': ' + v.status + (v.conclusion ? ' (' + v.conclusion + ')' : '') + ' after ' + Math.round((Date.now() - t0) / 1000) + 's');
        a.status = v.status;
        a.conclusion = v.conclusion;
        if (a.status !== 'completed') continue;
        if (a.conclusion !== 'success' && a.reruns < 2) {
          const jobs = (v.jobs || []).map((j) => ({ name: j.name, conclusion: j.conclusion, runner_name: j.startedAt && j.startedAt !== '0001-01-01T00:00:00Z' ? 'x' : '', steps: j.steps || [] }));
          const act = starvedAction(jobs, a.pool, iosPools.length);
          if (act.action === 'move') {
            a.ok = collect(a);
            await cleanerDel(a);
            a.replaced = true;
            a.finished = true;
            log(a.rid + ': GitHub gave no runner to ' + act.redo + ' on ' + iosPools[a.pool] + ', moving it to ' + iosPools[a.pool + 1]);
            await dispatch(act.redo, a.pool + 1, '-p' + (a.pool + 1), path.join(a.dir, 'on-' + iosPools[a.pool + 1]));
            continue;
          }
          if (act.action === 'rerun') {
            a.reruns++;
            a.minAttempt = (v.attempt || 1) + 1;
            log(a.rid + ': GitHub gave no runner to ' + act.redo + ', re-running (' + a.reruns + '/2)');
            gh(['run', 'rerun', String(a.id), '-R', REPO, '--failed']);
            a.status = 'queued';
            a.conclusion = null;
            continue;
          }
        }
        a.ok = collect(a);
        if (a.conclusion !== 'success') log(a.rid + ': run ' + a.conclusion);
        await cleanerDel(a);
        a.finished = true;
      }
      if (attempts.some((x) => !x.finished)) await sleep(20000 + Math.floor(Math.random() * 3000));
    }

    // ---- summary: paths only, never the hostname; text from the runner or the page is untrusted data
    let issues = 0;
    const T = (s, n) => untrusted(String(s).split(host).join('<site>'), n);
    const lines = ['# mobile-qa private ' + baseId, '', 'Trusted (computed here): paths, counts, file paths. Everything after a "[untrusted]" tag is text from the runner or the page: control characters removed, truncated, not verified.', ''];
    const files = [];
    const find = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) find(p); else if (e.name === 'results.json') files.push(p); } };
    for (const a of attempts) find(a.dir);
    for (const f of [...new Set(files)]) {
      const res = JSON.parse(fs.readFileSync(f, 'utf8'));
      const dir = path.dirname(f);
      const plat = res.platform === 'ios' ? 'ios' : 'android';
      lines.push('## ' + plat + ' [untrusted] ' + T(res.device, 80) + ', ' + T(res.browser, 80) + ' (' + T(res.mode, 40) + ')', '');
      if (plat === 'ios') lines.push('iOS: writes are not blocked in plain page loads (Safari has no request interception); flows use a page script guard injected after each document loads (see each flow).', '');
      for (const n of res.notes || []) lines.push('note [untrusted]: ' + T(n, 300));
      for (const p of res.pages || []) {
        const { bad, notes } = verdict(p);
        issues += bad.length;
        let where = '?';
        try { const u = new URL(p.url); where = u.pathname + u.hash; } catch { /* keep ? */ }
        const bw = (p.blockedWrites || []).length;
        const st = p.settle && !p.settle.settled ? ' (page did not settle in ' + Math.round(p.settle.ms / 1000) + ' s)' : '';
        lines.push('- ' + T(where, 80) + ' :: ' + (bad.length ? 'ISSUES: [untrusted] ' + T(bad.join(' | '), 300) : 'ok') + (notes.length ? ' [untrusted] (' + T(notes.join(', '), 300) + ')' : '') + st + (plat === 'android' ? ' [blocked writes/websockets: ' + bw + ']' : ''));
        for (const s of p.shots || []) lines.push('  - ' + path.join(dir, String(s).replace(/[^A-Za-z0-9._-]/g, '_')));
      }
      if (Array.isArray(res.flows) && res.flows.length) {
        const fr = reportFlows(res, dir, { T });
        issues += fr.issues;
        lines.push(...fr.lines);
      }
      lines.push('');
    }
    const failed = attempts.filter((a) => !a.replaced && (a.conclusion !== 'success' || !a.ok));
    if (failed.length) lines.push('Runs without full results: ' + failed.map((a) => a.rid + ' (' + a.conclusion + ')').join(', '));
    lines.push('', 'Session: the QA Agent session was not logged out (a logout would kill it for every other kit-qa user); it expires by itself within 2 h.');
    if (leak) lines.push('', 'LEAK DETECTED in this run (see the warnings above).');
    fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n'));
    console.log(lines.join('\n'));
    log('summary: ' + path.join(outDir, 'summary.md'));
    log('these screenshots show real admin data: delete ' + outDir + ' after you have looked at them');
    code = leak || !files.length || failed.length ? 2 : issues ? 1 : 0;
  } catch (e) {
    log('error: ' + e.message);
    code = 2;
  } finally {
    try {
      await cleanup();
      if (cleaner.rotationFailed()) {
        log('SECRET NOT ROTATED: exit 2');
        code = 2;
      }
    } finally {
      release();
    }
  }
  return code;

  async function cleanerDel(a) {
    try {
      gh(['run', 'delete', String(a.id), '-R', REPO]);
      a.deleted = true;
    } catch {
      log('could not delete ' + a.rid + '; cleanup retries');
    }
  }
  } finally {
    release();
  }
}
