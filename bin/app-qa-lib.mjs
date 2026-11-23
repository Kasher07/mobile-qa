// Shared by bin/app-qa.mjs and bin/app-qa-ios-bg.mjs: sealing, opening the results, the per-flow summary and the
// Codemagic API (iOS on a Mac mini M2).
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
export const makeLog = (prefix, sink) => (s) => { const line = '[' + prefix + ' +' + Math.round((Date.now() - t0) / 1000) + 's] ' + s; console.log(line); if (sink) { try { fs.appendFileSync(sink, line + '\n'); } catch { /* folder gone */ } } };

/** IV(12) | tag(16) | ciphertext, AES-256-GCM. */
export function seal(key, buf) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
export function open(key, blob) {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

// Windows' bsdtar packs and reads zips; Git's GNU tar writes the Vietnamese folder names Maestro uses.
const gitTar = process.platform === 'win32' ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'usr', 'bin', 'tar.exe')].find((f) => fs.existsSync(f)) : null;
export const unpackTar = gitTar || 'tar';
export const tarBin = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/**
 * Opens every sealed artifact folder in outDir (app-<platform>, build-<platform>, res-<platform>-<pass>-<flow>), each
 * holding one .enc file. Results unpack into outDir/<platform>-<pass>-<flow>; an app artifact goes to onApp(platform,
 * tgzPath) (the build kept for JS-only runs).
 */
export function openArtifacts({ outDir, key, work, onApp, log }) {
  for (const name of fs.existsSync(outDir) ? fs.readdirSync(outDir) : []) {
    const dir = path.join(outDir, name);
    const m = /^(app|build|res)-(.+)$/.exec(name);
    if (!m || !fs.statSync(dir).isDirectory()) continue;
    const sealed = fs.readdirSync(dir).find((f) => f.endsWith('.enc'));
    try {
      if (sealed) {
        const plain = open(key, fs.readFileSync(path.join(dir, sealed)));
        if (m[1] === 'app') {
          const tgz = path.join(work, 'app-' + m[2] + '.tgz');
          fs.writeFileSync(tgz, plain);
          onApp?.(m[2], tgz);
        } else {
          // Relative paths and cwd keep GNU tar from reading "D:" as a remote host.
          const target = path.join(outDir, m[2]);
          fs.mkdirSync(target, { recursive: true });
          fs.writeFileSync(path.join(target, 'r.tgz'), plain);
          execFileSync(unpackTar, ['-xzf', 'r.tgz'], { cwd: target, stdio: ['ignore', 'pipe', 'pipe'] });
          fs.rmSync(path.join(target, 'r.tgz'));
        }
      }
    } catch (e) {
      log(name + ': could not open (' + String(e.stderr || e.message).split('\n')[0].slice(0, 160) + ')');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Logs one line per flow and returns true when every flow of the platform passed. */
export function summarize({ outDir, platform, shards, log }) {
  let ok = shards.length > 0;
  let checked = false;
  for (const sh of shards) {
    const dir = path.join(outDir, platform + '-' + sh.pass + '-' + sh.flow);
    const ck = path.join(dir, 'checks.txt');
    if (!checked && fs.existsSync(ck)) { log(platform + ' checks:\n' + fs.readFileSync(ck, 'utf8').trim()); checked = true; }
    const j = path.join(dir, 'junit.xml');
    if (!fs.existsSync(j)) { log(platform + '/' + sh.pass + ' ' + sh.flow + ': no results'); ok = false; continue; }
    const cases = [...fs.readFileSync(j, 'utf8').matchAll(/<testcase[^>]*name="([^"]+)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g)];
    if (!cases.length) ok = false;
    for (const c of cases) {
      const failed = /<failure/.test(c[3] || '');
      if (failed) ok = false;
      log(platform + '/' + sh.pass + ': ' + (failed ? 'FAIL ' : 'ok   ') + c[1] + (failed ? ' - ' + ((c[3].match(/<failure[^>]*>([^<]{0,300})/) || c[3].match(/message="([^"]*)"/))?.[1] || '').trim() : ''));
    }
  }
  return ok;
}

// ---- Codemagic (free personal plan: 500 macOS M2 minutes a month, one build at a time)
export const kitDir = () => path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'kit-app-qa');
/** Build states Codemagic never leaves; everything else (queued, preparing, fetching, building, ...) is still going. */
export const CM_FINAL = ['finished', 'failed', 'canceled', 'timeout', 'skipped', 'warning'];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readToken = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
/**
 * Every configured Codemagic account, in order: codemagic.json + codemagic.token (account 1), then codemagic-<n>.json +
 * codemagic-<n>.token (n >= 2) in the kit folder. A free personal plan gives each account 500 build minutes a month and
 * one build at a time, so more accounts = more capacity. CODEMAGIC_TOKEN in the environment is a single-account
 * override: that token with the app id of account 1 (what a run of one account used before the pool existed).
 * Entry: { index, label: '#n', token, appId, workflowId }. An incomplete pair (no token or no appId) is skipped.
 */
export function codemagicConfigs() {
  const dir = kitDir();
  const entry = (index, token, conf) => (token && conf?.appId ? { index, label: '#' + index, token, appId: conf.appId, workflowId: conf.workflowId || 'app-qa-ios' } : null);
  if (process.env.CODEMAGIC_TOKEN) return [entry(1, process.env.CODEMAGIC_TOKEN, readJson(path.join(dir, 'codemagic.json')))].filter(Boolean);
  const out = [entry(1, readToken(path.join(dir, 'codemagic.token')), readJson(path.join(dir, 'codemagic.json')))];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no kit folder yet */ }
  for (const n of names.map((f) => /^codemagic-(\d+)\.json$/.exec(f)?.[1]).filter(Boolean).map(Number).filter((n) => n >= 2).sort((a, b) => a - b)) {
    out.push(entry(n, readToken(path.join(dir, 'codemagic-' + n + '.token')), readJson(path.join(dir, 'codemagic-' + n + '.json'))));
  }
  return out.filter(Boolean);
}
/** The first configured account (older callers). */
export const codemagicConfig = () => codemagicConfigs()[0] || null;
export function codemagic(cm, log) {
  const api = async (method, url, body) => {
    const r = await fetch('https://api.codemagic.io' + url, { method, headers: { 'x-auth-token': cm.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) {
      const e = new Error('Codemagic ' + method + ' ' + url + ': HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
      e.status = r.status;
      throw e;
    }
    return r.json();
  };
  return {
    api,
    /**
     * Builds of the app, newest first (GET /builds?appId=&limit=&skip=; each build has status, createdAt, startedAt,
     * finishedAt). Pages on until a page is short or its oldest build was created before sinceMs.
     */
    async listBuilds({ sinceMs = 0, limit = 50, maxPages = 10 } = {}) {
      const out = [];
      for (let page = 0; page < maxPages; page++) {
        const { builds = [] } = await api('GET', '/builds?appId=' + encodeURIComponent(cm.appId) + '&limit=' + limit + '&skip=' + page * limit);
        out.push(...builds);
        if (builds.length < limit || Date.parse(builds[builds.length - 1].createdAt) < sinceMs) break;
      }
      return out;
    },
    start: async (variables) => (await api('POST', '/builds', { appId: cm.appId, workflowId: cm.workflowId, branch: 'main', environment: { variables } })).buildId,
    cancel: (id) => api('POST', '/builds/' + id + '/cancel'),
    /** Waits for the end; onFetched() runs once the build has its encrypted input (the release can go). */
    async wait(id, { onFetched, notFoundRetryMs = 5000 } = {}) {
      let last = '';
      let fetched = false;
      let seen = false;
      const t0 = Date.now();
      for (;;) {
        let build;
        try { build = (await api('GET', '/builds/' + id)).build; seen = true; } catch (e) {
          // Right after POST /builds the id is not readable for a few seconds: 404 NOT_FOUND (2026-11-23: the same id
          // answered "queued" 21 s later, same token). Not an error until it stays 404 for 3 minutes.
          if (e.status === 404 && !seen && Date.now() - t0 < 3 * 60000) { await sleep(notFoundRetryMs); continue; }
          log(String(e.message).slice(0, 160)); await sleep(20000); continue;
        }
        const actions = build.buildActions || [];
        if (!fetched && actions.some((a) => /Fetch and decrypt/.test(a.name) && a.status === 'success')) { fetched = true; await onFetched?.(); }
        const step = actions.find((a) => a.status === 'building')?.name;
        const line = 'ios (Codemagic): ' + build.status + (step ? ' (' + step + ')' : '');
        if (line !== last) { log(line); last = line; }
        if (CM_FINAL.includes(build.status)) {
          if (!fetched) await onFetched?.();
          log('time ios (Codemagic): ' + Math.round((Date.now() - t0) / 6000) / 10 + ' min');
          for (const a of actions) if (a.startedAt && a.finishedAt) log('time ios | ' + a.name + ' | ' + Math.round((Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 1000) + ' s');
          return build;
        }
        if (Date.now() - t0 > 60 * 60000) throw new Error('Codemagic build timed out');
        await sleep(15000);
      }
    },
    /** Downloads the artefacts (one file each, or one zip) into the artifact-folder layout openArtifacts reads. */
    async download(build, work, outDir) {
      const tmp = path.join(work, 'codemagic');
      fs.mkdirSync(tmp, { recursive: true });
      const files = [];
      for (const art of build.artefacts || []) {
        const r = await fetch(art.url, { headers: { 'x-auth-token': cm.token } });
        if (!r.ok) { log('could not download ' + art.name + ': HTTP ' + r.status); continue; }
        const f = path.join(tmp, path.basename(art.name));
        fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
        if (!f.endsWith('.zip')) { files.push(f); continue; }
        execFileSync(tarBin, ['-xf', path.basename(f)], { cwd: tmp, stdio: 'ignore' });
        const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
        files.push(...walk(tmp).filter((x) => x.endsWith('.enc')));
      }
      for (const f of files) {
        const name = path.basename(f);
        const m = /^(app|build)-ios\.enc$/.exec(name) || /^(ios-.+)\.enc$/.exec(name);
        if (!m) continue;
        const folder = m[1] === 'app' || m[1] === 'build' ? m[1] + '-ios' : 'res-' + m[1];
        fs.mkdirSync(path.join(outDir, folder), { recursive: true });
        fs.copyFileSync(f, path.join(outDir, folder, name));
      }
      if (!files.length) log('Codemagic: no results came back');
    },
  };
}
