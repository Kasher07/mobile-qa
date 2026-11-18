#!/usr/bin/env node
// mobile-qa: real-phone screenshots of PUBLIC pages on GitHub Actions in the public repo Kasher07/mobile-qa
// (iOS Simulator Safari + Android emulator Chrome), then download the results and delete the run.
// Usage: node bin/mobile-qa.mjs <url> [more urls] [--platforms ios,android] [--out DIR] [--segments N]
//        [--ios-device "iPhone SE (3rd generation)"] [--file urls.txt] [--keep]
// Exit: 0 no issues, 1 issues found, 2 run failed / bad input.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.MOBILE_QA_REPO || 'Kasher07/mobile-qa';
const ACCOUNT = process.env.MOBILE_QA_ACCOUNT || 'Kasher07';
const WORKFLOW = 'mobile-qa.yml';
const API = 'https://api.github.com';
const PER_RUN = 12; // URLs per run: one simulator/emulator boot serves them all
const MAX_RUNS = 3; // parallel runs per call (free accounts get 5 macOS jobs at once)
const POLL_MS = 20000;
const DEADLINE_MS = 55 * 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log('[mobile-qa] ' + s);
function die(msg) {
  console.error('[mobile-qa] ' + msg);
  process.exit(2);
}

// ---- args
const opts = { platforms: 'ios,android', out: null, segments: 6, iosDevice: '', keep: false, urls: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--platforms') opts.platforms = argv[++i];
  else if (a === '--out') opts.out = argv[++i];
  else if (a === '--segments') opts.segments = Number(argv[++i]);
  else if (a === '--ios-device') opts.iosDevice = argv[++i];
  else if (a === '--keep') opts.keep = true;
  else if (a === '--file') opts.urls.push(...fs.readFileSync(argv[++i], 'utf8').split(/\s+/).filter(Boolean));
  else if (a === '-h' || a === '--help') {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 6).join('\n'));
    process.exit(0);
  } else if (a.startsWith('--')) die('unknown option ' + a);
  else opts.urls.push(a);
}
if (!/^(ios|android|ios,android|android,ios)$/.test(opts.platforms)) die('--platforms must be ios, android or ios,android');
if (!Number.isFinite(opts.segments) || opts.segments < 1 || opts.segments > 12) die('--segments must be 1..12');

// ---- guard: the repo is public, so only public pages and no secrets in URLs
const SECRET_KEY = /(token|key|secret|sig|signature|auth|code|pass|session|jwt|otp)/i;
function checkUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return 'not a URL';
  }
  if (!/^https?:$/.test(u.protocol)) return 'only http(s)';
  const h = u.hostname;
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return 'local host (runner cannot reach it)';
  if (/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h === '[::1]') return 'private IP (runner cannot reach it)';
  if (u.username || u.password) return 'credentials in URL (public repo)';
  for (const k of u.searchParams.keys()) if (SECRET_KEY.test(k)) return 'query parameter "' + k + '" looks secret (public repo)';
  if (u.hash && SECRET_KEY.test(u.hash)) return 'fragment looks secret (public repo)';
  return null;
}
const urls = [...new Set(opts.urls)];
if (!urls.length) die('no URLs. Usage: node bin/mobile-qa.mjs <url> [more urls] [--platforms ios,android]');
for (const u of urls) {
  const why = checkUrl(u);
  if (why) die('refused ' + u + ': ' + why);
}
if (urls.length > PER_RUN * MAX_RUNS) die('max ' + PER_RUN * MAX_RUNS + ' URLs per call (got ' + urls.length + '); split the list');

// ---- GitHub API with rate-limit handling
let token;
try {
  token = execFileSync('gh', ['auth', 'token', '--user', ACCOUNT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch {
  die(ACCOUNT + ' is not logged in to gh: run  gh auth login --web --scopes workflow  then  gh auth switch --user KitTran1307');
}
async function api(method, p, body, attempt = 0) {
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
    if (attempt < 4) {
      await sleep(5000 * (attempt + 1));
      return api(method, p, body, attempt + 1);
    }
    throw e;
  }
  if ((r.status === 403 || r.status === 429) && attempt < 4) {
    const retryAfter = Number(r.headers.get('retry-after'));
    const remaining = r.headers.get('x-ratelimit-remaining');
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    if (retryAfter || remaining === '0') {
      const wait = retryAfter ? retryAfter * 1000 : Math.max(60000, reset * 1000 - Date.now() + 2000);
      log('GitHub rate limit, waiting ' + Math.round(wait / 1000) + 's');
      await sleep(Math.min(wait, 15 * 60000));
      return api(method, p, body, attempt + 1);
    }
  }
  if (r.status >= 500 && attempt < 4) {
    await sleep(10000 * (attempt + 1));
    return api(method, p, body, attempt + 1);
  }
  const text = await r.text();
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + text.slice(0, 300));
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// ---- dispatch one run per chunk
const baseId = 'mq-' + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '') + '-' + Math.random().toString(36).slice(2, 6);
const outDir = path.resolve(opts.out || path.join(os.tmpdir(), 'mobile-qa', baseId));
fs.mkdirSync(outDir, { recursive: true });
const chunks = [];
for (let i = 0; i < urls.length; i += PER_RUN) chunks.push(urls.slice(i, i + PER_RUN));

async function dispatch(chunk, i) {
  const rid = chunks.length > 1 ? baseId + '-' + (i + 1) : baseId;
  const wfPath = '/repos/' + REPO + '/actions/workflows/' + WORKFLOW;
  const res = await api('POST', wfPath + '/dispatches', {
    ref: 'main',
    inputs: { urls: chunk.join('\n'), platforms: opts.platforms, request_id: rid, max_segments: String(opts.segments), ios_device: opts.iosDevice },
    return_run_details: true,
  });
  let id = res && (res.workflow_run_id || res.id);
  for (let t = 0; !id && t < 12; t++) {
    await sleep(5000);
    const l = await api('GET', wfPath + '/runs?event=workflow_dispatch&per_page=20');
    const m = (l.workflow_runs || []).find((x) => x.display_title === rid);
    if (m) id = m.id;
  }
  if (!id) throw new Error('dispatched ' + rid + ' but could not find its run');
  log('run ' + rid + ' -> https://github.com/' + REPO + '/actions/runs/' + id + ' (' + chunk.length + ' URLs, ' + opts.platforms + ')');
  return { rid, id, chunk, status: 'queued', conclusion: null, dir: chunks.length > 1 ? path.join(outDir, 'part' + (i + 1)) : outDir };
}
const runs = await Promise.all(chunks.map(dispatch));

// ---- wait (one request per run per poll; ~3 requests/min per run, far under 5000/h)
const t0 = Date.now();
await sleep(30000);
while (runs.some((r) => r.status !== 'completed')) {
  if (Date.now() - t0 > DEADLINE_MS) {
    log('timed out waiting; runs left on GitHub for inspection');
    process.exit(2);
  }
  for (const r of runs.filter((x) => x.status !== 'completed')) {
    const v = await api('GET', '/repos/' + REPO + '/actions/runs/' + r.id);
    if (v.status !== r.status) log(r.rid + ': ' + v.status + (v.conclusion ? ' (' + v.conclusion + ')' : '') + ' after ' + Math.round((Date.now() - t0) / 1000) + 's');
    r.status = v.status;
    r.conclusion = v.conclusion;
  }
  if (runs.some((r) => r.status !== 'completed')) await sleep(POLL_MS + Math.floor(Math.random() * 3000));
}

// ---- download, then delete the run (logs + artifacts) so nothing stays public
for (const r of runs) {
  fs.mkdirSync(r.dir, { recursive: true });
  try {
    execFileSync('gh', ['run', 'download', String(r.id), '-R', REPO, '-D', r.dir], {
      env: Object.assign({}, process.env, { GH_TOKEN: token }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    log(r.rid + ': download failed: ' + String(e.stderr || e).slice(0, 200));
  }
  if (r.conclusion !== 'success') {
    log(r.rid + ': run ' + r.conclusion + ', kept for its logs: https://github.com/' + REPO + '/actions/runs/' + r.id);
  } else if (!opts.keep) {
    await api('DELETE', '/repos/' + REPO + '/actions/runs/' + r.id).catch((e) => log('delete failed: ' + e.message));
  }
}

// ---- summary
function findResults(dir) {
  const found = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...findResults(p));
    else if (e.name === 'results.json') found.push(p);
  }
  return found;
}
const files = findResults(outDir);
let issues = 0;
const lines = ['# mobile-qa ' + baseId, ''];
for (const f of files) {
  const res = JSON.parse(fs.readFileSync(f, 'utf8'));
  const dir = path.dirname(f);
  lines.push('## ' + res.platform + ': ' + res.device + ', ' + res.browser + ' (' + res.mode + ')', '');
  for (const p of res.pages) {
    const pr = p.probe || {};
    const bad = [];
    if (p.error) bad.push('ERROR ' + p.error);
    if (p.status && p.status >= 400) bad.push('HTTP ' + p.status);
    if (pr.overflowX) bad.push('horizontal overflow ' + pr.scrollWidth + '>' + pr.innerWidth + ' [' + (pr.wide || []).slice(0, 3).join('; ') + ']');
    if (p.pageErrors.length) bad.push(p.pageErrors.length + ' JS errors: ' + p.pageErrors[0]);
    if (p.probe && !pr.viewportMeta) bad.push('no viewport meta');
    if (!p.shots.length) bad.push('no screenshot');
    const notes = [];
    if (p.consoleErrors.length) notes.push(p.consoleErrors.length + ' console errors');
    if (p.failedRequests.length) notes.push(p.failedRequests.length + ' failed requests');
    if ((pr.smallTapTargets || []).length) notes.push(pr.smallTapTargets.length + ' tap targets <24px');
    issues += bad.length;
    lines.push('- ' + p.url + ' :: ' + (bad.length ? 'ISSUES: ' + bad.join(' | ') : 'ok') + (notes.length ? ' (' + notes.join(', ') + ')' : ''));
    for (const s of p.shots) lines.push('  - ' + path.join(dir, s));
  }
  lines.push('');
}
const failedRuns = runs.filter((r) => r.conclusion !== 'success');
if (!files.length) lines.push('No results downloaded.');
fs.writeFileSync(path.join(outDir, 'summary.md'), lines.join('\n'));
console.log(lines.join('\n'));
log('summary: ' + path.join(outDir, 'summary.md'));
process.exit(!files.length || failedRuns.length ? 2 : issues ? 1 : 0);
