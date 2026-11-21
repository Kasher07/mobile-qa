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
import { buildJob, sealJob, unseal, resultAad } from '../runner/private.mjs';

const REPO = process.env.MOBILE_QA_REPO || 'Kasher07/mobile-qa';
const ACCOUNT = process.env.MOBILE_QA_ACCOUNT || 'Kasher07';
const REF = process.env.MOBILE_QA_REF || 'main'; // the branch whose workflow runs (set to test a branch before it is merged)
const WORKFLOW = 'mobile-qa.yml';
const SECRET = 'PRIVATE_QA_KEY';
const DEADLINE_MS = 75 * 60000;
const log = (s) => console.log('[mobile-qa:private] ' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ageMin = (t) => (Date.now() - Date.parse(t)) / 60000;

// Pure part (tested): what the leak scan looks for in text.
export function leakScan(text, needles) {
  const hits = {};
  for (const [name, value] of Object.entries(needles)) {
    const list = [].concat(value).filter((v) => v && v.length >= 6);
    hits[name] = list.filter((v) => text.includes(v) || text.includes(encodeURIComponent(v))).length;
  }
  return hits;
}

export async function runPrivate(opts, deps) {
  const { verdict, starvedAction, iosPools, InputError } = deps;
  let built;
  try {
    built = buildJob(process.env, opts.urls);
  } catch (e) {
    throw new InputError(e.message);
  }
  const { job, host } = built;
  let token;
  try {
    token = execFileSync('gh', ['auth', 'token', '--user', ACCOUNT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new InputError('gh could not give the ' + ACCOUNT + ' token (gh auth login --web --scopes workflow, then switch back to your account)');
  }
  const env = { ...process.env, GH_TOKEN: token };
  delete env.KITQA_STORAGE_STATE;
  const gh = (args, o = {}) => execFileSync('gh', args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 << 20, ...o });
  // The key goes through stdin, never the command line.
  const setKey = (hex) => execFileSync('gh', ['secret', 'set', SECRET, '-R', REPO], { env, input: hex, stdio: ['pipe', 'pipe', 'pipe'] });
  const secretTime = () => {
    try {
      return JSON.parse(gh(['secret', 'list', '-R', REPO, '--json', 'name,updatedAt'])).find((s) => s.name === SECRET)?.updatedAt || '?';
    } catch {
      return '?';
    }
  };
  const listRuns = () => JSON.parse(gh(['run', 'list', '-R', REPO, '-w', WORKFLOW, '-L', '50', '--json', 'databaseId,displayTitle,status,createdAt,updatedAt']));
  const mine = (r) => /^pq-/.test(r.displayTitle || '');

  // ---- one private run at a time (they share the secret); leftovers of a killed caller are removed first
  const sweepAndLock = () => {
    let stale = false;
    const all = listRuns().filter(mine);
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

  const keyHex = randomBytes(32).toString('hex');
  const baseId = 'pq-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '-' + randomBytes(2).toString('hex');
  const outDir = path.join(path.resolve(opts.out || path.join(os.tmpdir(), 'mobile-qa')), baseId);
  fs.mkdirSync(outDir, { recursive: true });
  const needles = { host: [host], cookie: job.cookies.map((c) => c.value), key: [keyHex] };
  const attempts = [];
  let secretSet = false;
  let cleaning = null;

  async function removeRun(a) {
    if (a.deleted) return;
    try {
      gh(['run', 'delete', String(a.id), '-R', REPO]);
      a.deleted = true;
    } catch {
      log('could not delete ' + a.rid + '; the next private call sweeps it: https://github.com/' + REPO + '/actions/runs/' + a.id);
    }
  }
  function cleanup() {
    cleaning ??= (async () => {
      for (const a of attempts) {
        if (a.deleted) continue;
        if (a.status !== 'completed') {
          try { gh(['run', 'cancel', String(a.id), '-R', REPO]); } catch { /* ending */ }
          for (let t = 0; t < 24; t++) {
            await sleep(5000);
            try { if (JSON.parse(gh(['run', 'view', String(a.id), '-R', REPO, '--json', 'status'])).status === 'completed') break; } catch { break; }
          }
        }
        await removeRun(a);
      }
      if (secretSet) {
        const before = secretTime();
        try {
          setKey(randomBytes(32).toString('hex'));
          log('secret replaced with random bytes (updated ' + before + ' -> ' + secretTime() + ')');
        } catch (e) {
          log('WARNING: could not replace the secret: ' + String(e.stderr || e.message).slice(0, 150));
        }
      }
    })();
    return cleaning;
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => { log('interrupted, cleaning up'); cleanup().finally(() => process.exit(2)); });

  async function dispatch(platforms, pool, suffix, dir) {
    const rid = baseId + suffix;
    const inputs = { urls: 'private', platforms, request_id: rid, max_segments: String(opts.segments), ios_device: opts.iosDevice, ios_runner: iosPools[pool], ios_mode: opts.iosMode, private_job: sealJob(job, keyHex, rid) };
    gh(['workflow', 'run', WORKFLOW, '-R', REPO, '--ref', REF, '--json'], { input: JSON.stringify(inputs) });
    let id = null;
    for (let t = 0; !id && t < 24; t++) {
      await sleep(5000);
      id = listRuns().find((r) => r.displayTitle === rid)?.databaseId ?? null;
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
    let rawFiles = 0;
    let rawOther = 0;
    let rawLeak = 0;
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const buf = fs.readFileSync(p);
          rawFiles++;
          rawBytes += buf.length;
          if (!e.name.endsWith('.enc')) rawOther++;
          const hit = leakScan(buf.toString('latin1'), { host: needles.host, cookie: needles.cookie });
          rawLeak += hit.host + hit.cookie + (buf.subarray(0, 8).toString('latin1').includes('PNG') || buf.subarray(0, 2).toString('hex') === '1f8b' ? 1 : 0);
        }
      }
    };
    walk(raw);
    log(a.rid + ': raw artifact: ' + rawFiles + ' file(s), ' + rawBytes + ' bytes, ' + rawOther + ' not .enc, ' + rawLeak + ' readable marker(s)');
    let got = 0;
    for (const p of a.platforms.split(',')) {
      const f = path.join(raw, p, p + '.enc');
      if (!fs.existsSync(f)) continue;
      try {
        const tgz = path.join(a.dir, p + '.tgz');
        fs.writeFileSync(tgz, unseal(fs.readFileSync(f), keyHex, resultAad(a.rid, p)));
        fs.mkdirSync(path.join(a.dir, p), { recursive: true });
        execFileSync('tar', ['-xzf', p + '.tgz', '-C', p], { cwd: a.dir, stdio: ['ignore', 'pipe', 'pipe'] });
        fs.rmSync(tgz);
        got += fs.existsSync(path.join(a.dir, p, 'results.json')) ? 1 : 0;
      } catch (e) {
        log(a.rid + ': could not unseal ' + p + ': ' + String(e.message).slice(0, 100));
      }
    }
    fs.rmSync(raw, { recursive: true, force: true });
    try {
      const text = gh(['run', 'view', String(a.id), '-R', REPO, '--log']);
      const h = leakScan(text, needles);
      log(a.rid + ': run log checked (' + text.split('\n').length + ' lines): hostname ' + h.host + ', cookie values ' + h.cookie + ', key ' + h.key + ' occurrence(s)');
      fs.writeFileSync(path.join(a.dir, 'run-log-check.txt'), 'lines ' + text.split('\n').length + '\nhostname ' + h.host + '\ncookie ' + h.cookie + '\nkey ' + h.key + '\n');
    } catch (e) {
      log(a.rid + ': run log could not be read, leak scan NOT done: ' + String(e.stderr || e.message).split('\n')[0].slice(0, 120));
    }
    return got === a.platforms.split(',').length;
  }

  let code = 2;
  try {
    sweepAndLock();
    setKey(keyHex);
    secretSet = true;
    await dispatch(opts.platforms, 0, '', outDir);
    const t0 = Date.now();
    await sleep(30000);
    let apiErrors = 0;
    while (attempts.some((a) => !a.finished)) {
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
          const jobs = (v.jobs || []).map((j) => ({ name: j.name, conclusion: j.conclusion, runner_name: j.runnerName || (j.startedAt && j.startedAt !== '0001-01-01T00:00:00Z' ? 'x' : ''), steps: j.steps || [] }));
          const act = starvedAction(jobs, a.pool, iosPools.length);
          if (act.action === 'move') {
            a.ok = collect(a);
            await removeRun(a);
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
        await removeRun(a);
        a.finished = true;
      }
      if (attempts.some((x) => !x.finished)) await sleep(20000 + Math.floor(Math.random() * 3000));
    }

    // ---- summary: paths only, never the hostname
    let issues = 0;
    let blockedTotal = 0;
    const scrub = (s) => String(s).split(host).join('<site>');
    const lines = ['# mobile-qa private ' + baseId, ''];
    const files = [];
    const find = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) find(p); else if (e.name === 'results.json') files.push(p); } };
    for (const a of attempts) find(a.dir);
    for (const f of [...new Set(files)]) {
      const res = JSON.parse(fs.readFileSync(f, 'utf8'));
      const dir = path.dirname(f);
      lines.push('## ' + res.platform + ': ' + res.device + ', ' + res.browser + ' (' + res.mode + ')', '');
      for (const n of res.notes || []) lines.push('note: ' + scrub(n));
      for (const p of res.pages || []) {
        const { bad, notes } = verdict(p);
        issues += bad.length;
        const u = new URL(p.url);
        const bw = (p.blockedWrites || []).length;
        blockedTotal += bw;
        lines.push('- ' + u.pathname + u.hash + ' :: ' + (bad.length ? 'ISSUES: ' + scrub(bad.join(' | ')) : 'ok') + (notes.length ? ' (' + scrub(notes.join(', ')) + ')' : '') + (res.platform === 'android' ? ' [blocked writes: ' + bw + ']' : ''));
        for (const s of p.shots || []) lines.push('  - ' + path.join(dir, s));
      }
      lines.push('');
    }
    const failed = attempts.filter((a) => !a.replaced && (a.conclusion !== 'success' || !a.ok));
    if (failed.length) lines.push('Runs without full results: ' + failed.map((a) => a.rid + ' (' + a.conclusion + ')').join(', '));
    lines.push('', 'Session: kit-qa\'s QA Agent session was not logged out (a logout would kill it for every other kit-qa user); it expires by itself within 2 h.');
    fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n'));
    console.log(lines.join('\n'));
    log('summary: ' + path.join(outDir, 'summary.md'));
    code = !files.length || failed.length ? 2 : issues ? 1 : 0;
  } catch (e) {
    log('error: ' + e.message);
    code = 2;
  } finally {
    await cleanup();
  }
  return code;
}
