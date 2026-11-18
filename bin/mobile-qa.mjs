#!/usr/bin/env node
// mobile-qa: real-phone screenshots of PUBLIC pages on GitHub Actions in the public repo Kasher07/mobile-qa
// (iOS Simulator Safari + Android emulator Chrome), then download the results and delete the run.
// Usage: node bin/mobile-qa.mjs <url> [more urls] [--platforms ios,android] [--out DIR] [--segments N]
//        [--ios-device "iPhone SE (3rd generation)"] [--file urls.txt] [--keep]
// Exit: 0 no issues, 1 issues found, 2 run failed / bad input / tool error.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.MOBILE_QA_REPO || 'Kasher07/mobile-qa';
const ACCOUNT = process.env.MOBILE_QA_ACCOUNT || 'Kasher07';
const WORKFLOW = 'mobile-qa.yml';
const API = 'https://api.github.com';
const PER_RUN = 12; // URLs per run: one simulator/emulator boot serves them all
const MAX_RUNS = 3; // runs per call (free accounts run 5 macOS jobs at once)
const POLL_MS = 20000;
const DEADLINE_MS = 75 * 60000;
const MAX_RERUNS = 2; // GitHub sometimes never assigns a macOS runner ("not acquired ... capacity constraints")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log('[mobile-qa] ' + s);
class InputError extends Error {}

// ---- args
export function parseArgs(argv) {
  const opts = { platforms: 'ios,android', out: null, segments: 6, iosDevice: '', keep: false, urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platforms') opts.platforms = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--segments') opts.segments = Number(argv[++i]);
    else if (a === '--ios-device') opts.iosDevice = argv[++i] || '';
    else if (a === '--keep') opts.keep = true;
    else if (a === '--file') opts.urls.push(...fs.readFileSync(argv[++i], 'utf8').split(/\s+/).filter(Boolean));
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 7).join('\n'));
      process.exit(0);
    } else if (a.startsWith('--')) throw new InputError('unknown option ' + a);
    else opts.urls.push(a);
  }
  if (!/^(ios|android|ios,android|android,ios)$/.test(opts.platforms || '')) throw new InputError('--platforms must be ios, android or ios,android');
  if (!Number.isInteger(opts.segments) || opts.segments < 1 || opts.segments > 12) throw new InputError('--segments must be 1..12');
  if (/[\r\n]/.test(opts.iosDevice)) throw new InputError('bad --ios-device');
  return opts;
}

// ---- guard: the repo is public, so only public pages and nothing secret-looking in URLs
const SECRET_PARTS = new Set(['token', 'accesstoken', 'key', 'apikey', 'secret', 'sig', 'signature', 'auth', 'authorization',
  'code', 'pass', 'password', 'passwd', 'pwd', 'session', 'sessionid', 'sid', 'jwt', 'otp', 'credential', 'credentials', 'nonce', 'ticket']);
const secretName = (k) => {
  const low = k.toLowerCase();
  if (/^x-(amz|goog)-/.test(low)) return true;
  return SECRET_PARTS.has(low.replace(/[^a-z0-9]/g, '')) || low.split(/[^a-z0-9]+/).some((p) => SECRET_PARTS.has(p));
};
// JWTs and long random strings without separators (slugs have hyphens, so they pass).
const secretValue = (v) => /^eyJ[A-Za-z0-9_-]{10,}/.test(v) || /^(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{24,}$/.test(v);
const privateIPv4 = (h) =>
  /^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);

export function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { why: 'not a URL' };
  }
  if (!/^https?:$/.test(u.protocol)) return { why: 'only http(s)' };
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[')) return { why: 'IP address literal, use the public hostname' };
  if (h === 'localhost' || /\.(localhost|local|internal|lan|home|corp)$/.test(h)) return { why: 'local host (runner cannot reach it)' };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) && privateIPv4(h)) return { why: 'private IP (runner cannot reach it)' };
  if (!h.includes('.')) return { why: 'single-label host (not public)' };
  if (u.username || u.password) return { why: 'credentials in URL (public repo)' };
  for (const [k, v] of u.searchParams) {
    if (secretName(k)) return { why: 'query parameter "' + k + '" looks secret (public repo)' };
    if (secretValue(v)) return { why: 'query value of "' + k + '" looks like a token (public repo)' };
  }
  for (const seg of u.pathname.split('/')) if (secretValue(decodeURIComponent(seg))) return { why: 'path segment looks like a token (public repo)' };
  if (u.hash && (secretName(u.hash.slice(1).split('=')[0]) || /eyJ[A-Za-z0-9_-]{10,}/.test(u.hash))) return { why: 'fragment looks secret (public repo)' };
  if (/[,\s]/.test(u.href)) return { why: 'comma or space in URL (the runner splits on them)' };
  return { href: u.href };
}

// ---- GitHub API with rate-limit handling
let token = null;
async function api(method, p, body, { retry = true } = {}, attempt = 0) {
  let r;
  try {
    r = await fetch(API + p, {
      method,
      headers: {
        authorization: 'Bearer ' + token,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'kit-mobile-qa',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    if (retry && attempt < 4) {
      await sleep(5000 * (attempt + 1));
      return api(method, p, body, { retry }, attempt + 1);
    }
    throw new Error(method + ' ' + p + ': ' + e.message);
  }
  const text = await r.text();
  if ((r.status === 403 || r.status === 429) && attempt < 4) {
    const retryAfter = Number(r.headers.get('retry-after')) || 0;
    const primary = r.headers.get('x-ratelimit-remaining') === '0';
    const secondary = /secondary rate limit|abuse/i.test(text);
    if (retryAfter || primary || secondary) {
      const reset = Number(r.headers.get('x-ratelimit-reset')) || 0;
      let wait = retryAfter ? retryAfter * 1000 : primary ? reset * 1000 - Date.now() + 2000 : 60000 * (attempt + 1);
      wait = Math.min(Math.max(wait, 60000), 15 * 60000);
      log('GitHub ' + (primary ? 'rate' : 'secondary rate') + ' limit, waiting ' + Math.round(wait / 1000) + 's');
      await sleep(wait);
      return api(method, p, body, { retry }, attempt + 1);
    }
  }
  if (r.status >= 500 && retry && attempt < 4) {
    await sleep(10000 * (attempt + 1));
    return api(method, p, body, { retry }, attempt + 1);
  }
  if (!r.ok) {
    const e = new Error(method + ' ' + p + ' -> ' + r.status + ' ' + text.slice(0, 300));
    e.status = r.status;
    throw e;
  }
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
const ghEnv = () => Object.assign({}, process.env, { GH_TOKEN: token });
const runUrl = (id) => 'https://github.com/' + REPO + '/actions/runs/' + id;

// ---- state shared with cleanup
const runs = [];
let outDir = null;
let opts = null;

async function findRunByTitle(rid) {
  const l = await api('GET', '/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/runs?event=workflow_dispatch&per_page=30');
  const m = ((l && l.workflow_runs) || []).find((x) => x.display_title === rid);
  return m ? m.id : null;
}

async function dispatch(chunk, i, baseId, total) {
  const rid = total > 1 ? baseId + '-' + (i + 1) : baseId;
  let id = null;
  try {
    // Never retried: a POST that timed out may still have queued a run (duplicates would stay public).
    const res = await api('POST', '/repos/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches', {
      ref: 'main',
      inputs: { urls: chunk.join('\n'), platforms: opts.platforms, request_id: rid, max_segments: String(opts.segments), ios_device: opts.iosDevice },
      return_run_details: true,
    }, { retry: false });
    id = res && (res.workflow_run_id || res.id);
  } catch (e) {
    if (e.status && e.status < 500 && e.status !== 408) throw e;
    log('dispatch ' + rid + ' uncertain (' + e.message.slice(0, 120) + '), looking for its run');
  }
  for (let t = 0; !id && t < 12; t++) {
    await sleep(5000);
    id = await findRunByTitle(rid);
  }
  if (!id) throw new Error('could not find the run of ' + rid);
  const dir = total > 1 ? path.join(outDir, 'part' + (i + 1)) : outDir;
  const r = { rid, id, chunk, status: 'queued', conclusion: null, dir, deleted: false, downloaded: false, reruns: 0 };
  runs.push(r);
  log('run ' + rid + ' -> ' + runUrl(id) + ' (' + chunk.length + ' URLs, ' + opts.platforms + ')');
  return r;
}

function download(r) {
  fs.mkdirSync(r.dir, { recursive: true });
  try {
    execFileSync('gh', ['run', 'download', String(r.id), '-R', REPO, '-D', r.dir], { env: ghEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log(r.rid + ': download failed: ' + String(e.stderr || e.message).slice(0, 200));
  }
  const want = opts.platforms.split(',');
  return want.every((p) => fs.existsSync(path.join(r.dir, p, 'results.json')));
}

function saveFailedLog(r) {
  try {
    const out = execFileSync('gh', ['run', 'view', String(r.id), '-R', REPO, '--log-failed'], { env: ghEnv(), encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
    fs.mkdirSync(r.dir, { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'failed.log'), out);
    log(r.rid + ': failed-step log saved to ' + path.join(r.dir, 'failed.log'));
  } catch (e) {
    log(r.rid + ': could not save the failed log: ' + String(e.stderr || e.message).slice(0, 200));
  }
}

async function removeRun(r) {
  if (r.deleted || opts.keep) return;
  try {
    await api('DELETE', '/repos/' + REPO + '/actions/runs/' + r.id);
    r.deleted = true;
  } catch (e) {
    log(r.rid + ': delete failed (' + e.message.slice(0, 120) + '); delete it by hand: ' + runUrl(r.id));
  }
}

// Leaves nothing public behind: cancels unfinished runs, keeps failed logs locally, deletes every run whose results
// are safe on disk (or that failed). A successful run whose download failed is kept so it can be downloaded again.
let cleaning = null;
function cleanup(reason) {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    for (const r of runs) {
      if (r.deleted) continue;
      if (r.status !== 'completed') {
        log(r.rid + ': cancelling (' + reason + ')');
        await api('POST', '/repos/' + REPO + '/actions/runs/' + r.id + '/cancel').catch(() => {});
        for (let t = 0; t < 12; t++) {
          await sleep(5000);
          const v = await api('GET', '/repos/' + REPO + '/actions/runs/' + r.id).catch(() => null);
          if (!v || v.status === 'completed') break;
        }
        saveFailedLog(r);
        await removeRun(r);
      } else if (r.downloaded || r.conclusion !== 'success') {
        await removeRun(r);
      } else {
        log(r.rid + ': kept (results not downloaded): ' + runUrl(r.id) + ' - artifacts expire in 1 day, delete it after');
      }
    }
  })();
  return cleaning;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    log('interrupted, cleaning up');
    cleanup('interrupted').finally(() => process.exit(2));
  });
}

function findResults(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...findResults(p));
    else if (e.name === 'results.json') found.push(p);
  }
  return found;
}

async function main() {
  opts = parseArgs(process.argv.slice(2));
  const urls = [];
  for (const raw of [...new Set(opts.urls)]) {
    const c = checkUrl(raw);
    if (c.why) throw new InputError('refused ' + raw + ': ' + c.why);
    if (!urls.includes(c.href)) urls.push(c.href);
  }
  if (!urls.length) throw new InputError('no URLs. Usage: node bin/mobile-qa.mjs <url> [more urls] [--platforms ios,android]');
  if (urls.length > PER_RUN * MAX_RUNS) throw new InputError('max ' + PER_RUN * MAX_RUNS + ' URLs per call (got ' + urls.length + '); split the list');

  try {
    token = execFileSync('gh', ['auth', 'token', '--user', ACCOUNT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    throw new InputError('gh could not give the ' + ACCOUNT + ' token (' + String(e.stderr || e.message).trim().slice(0, 160) +
      '). If it is not logged in: gh auth login --web --scopes workflow, then gh auth switch --user KitTran1307');
  }

  const baseId = 'mq-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '-' + Math.random().toString(36).slice(2, 6);
  outDir = path.join(path.resolve(opts.out || path.join(os.tmpdir(), 'mobile-qa')), baseId); // always a fresh folder
  fs.mkdirSync(outDir, { recursive: true });
  const chunks = [];
  for (let i = 0; i < urls.length; i += PER_RUN) chunks.push(urls.slice(i, i + PER_RUN));
  for (const [i, chunk] of chunks.entries()) await dispatch(chunk, i, baseId, chunks.length); // serial: GitHub asks for no concurrent writes

  // wait: one request per unfinished run per poll (~3/min per run, far under 5000/h)
  const t0 = Date.now();
  await sleep(30000);
  while (runs.some((r) => r.status !== 'completed')) {
    if (Date.now() - t0 > DEADLINE_MS) {
      log('timed out after ' + Math.round(DEADLINE_MS / 60000) + ' min');
      await cleanup('timeout');
      return 2;
    }
    for (const r of runs.filter((x) => x.status !== 'completed')) {
      const v = await api('GET', '/repos/' + REPO + '/actions/runs/' + r.id);
      if (v.status !== r.status) log(r.rid + ': ' + v.status + (v.conclusion ? ' (' + v.conclusion + ')' : '') + ' after ' + Math.round((Date.now() - t0) / 1000) + 's');
      r.status = v.status;
      r.conclusion = v.conclusion;
      if (r.status === 'completed' && r.conclusion !== 'success' && r.reruns < MAX_RERUNS) {
        // A job that never got a runner has no runner name and no steps: re-run only the failed jobs (the
        // finished platform keeps its artifact), instead of reporting a failure GitHub caused.
        const j = await api('GET', '/repos/' + REPO + '/actions/runs/' + r.id + '/jobs?filter=latest');
        const starved = ((j && j.jobs) || []).filter((x) => x.conclusion !== 'success' && x.conclusion !== 'skipped' && !x.runner_name && !(x.steps || []).length);
        if (starved.length) {
          r.reruns++;
          log(r.rid + ': GitHub gave no runner to ' + starved.map((x) => x.name).join(', ') + ', re-running (' + r.reruns + '/' + MAX_RERUNS + ')');
          await api('POST', '/repos/' + REPO + '/actions/runs/' + r.id + '/rerun-failed-jobs');
          r.status = 'queued';
          r.conclusion = null;
        }
      }
    }
    if (runs.some((r) => r.status !== 'completed')) await sleep(POLL_MS + Math.floor(Math.random() * 3000));
  }

  for (const r of runs) {
    r.downloaded = download(r);
    if (!r.downloaded && r.conclusion === 'success') {
      await sleep(10000);
      r.downloaded = download(r);
    }
    if (r.conclusion !== 'success') {
      log(r.rid + ': run ' + r.conclusion);
      saveFailedLog(r);
    }
  }
  await cleanup('done');

  // summary
  let issues = 0;
  const lines = ['# mobile-qa ' + baseId, ''];
  const files = runs.flatMap((r) => findResults(r.dir));
  for (const f of files) {
    let res;
    try {
      res = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {
      lines.push('- unreadable ' + f + ': ' + e.message, '');
      issues++;
      continue;
    }
    const dir = path.dirname(f);
    lines.push('## ' + res.platform + ': ' + res.device + ', ' + res.browser + ' (' + res.mode + ')', '');
    for (const p of res.pages || []) {
      const pr = p.probe || {};
      const bad = [];
      if (p.error) bad.push('ERROR ' + p.error);
      if (p.status && p.status >= 400) bad.push('HTTP ' + p.status);
      if (pr.overflowX) bad.push('horizontal overflow ' + pr.scrollWidth + '>' + pr.innerWidth + ' [' + (pr.wide || []).slice(0, 3).join('; ') + ']');
      if ((p.pageErrors || []).length) bad.push(p.pageErrors.length + ' JS errors: ' + p.pageErrors[0]);
      if (p.probe && !pr.viewportMeta) bad.push('no viewport meta');
      if (!(p.shots || []).length) bad.push('no screenshot');
      const notes = [];
      if ((p.consoleErrors || []).length) notes.push(p.consoleErrors.length + ' console errors');
      if ((p.failedRequests || []).length) notes.push(p.failedRequests.length + ' failed requests');
      if ((pr.smallTapTargets || []).length) notes.push(pr.smallTapTargets.length + ' tap targets <24px');
      if (p.segmentsNeeded && p.segmentsNeeded > (p.shots || []).length) notes.push('screens ' + p.shots.length + '/' + p.segmentsNeeded + ' (raise --segments to see the rest)');
      issues += bad.length;
      lines.push('- ' + p.url + ' :: ' + (bad.length ? 'ISSUES: ' + bad.join(' | ') : 'ok') + (notes.length ? ' (' + notes.join(', ') + ')' : ''));
      for (const s of p.shots || []) lines.push('  - ' + path.join(dir, s));
    }
    lines.push('');
  }
  const failed = runs.filter((r) => r.conclusion !== 'success' || !r.downloaded);
  if (failed.length) lines.push('Runs without full results: ' + failed.map((r) => r.rid + ' (' + r.conclusion + (r.downloaded ? '' : ', not downloaded') + ')').join(', '));
  fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n'));
  console.log(lines.join('\n'));
  log('summary: ' + path.join(outDir, 'summary.md'));
  return !files.length || failed.length ? 2 : issues ? 1 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch(async (e) => {
      log((e instanceof InputError ? '' : 'error: ') + e.message);
      if (runs.length) await cleanup('error');
      process.exit(2);
    });
}
