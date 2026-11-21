// Private mode (qa-agent sites): the job (site origin, paths, session cookies of that host) and every result are
// AES-256-GCM sealed with a per-call key held in the repo secret PRIVATE_QA_KEY, because this repo is public.
// Format: IV(12) | tag(16) | ciphertext. The additional data binds a blob to its run id (and platform for results).
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_RE = /^[0-9a-f]{64}$/;
export const jobAad = (rid) => 'mq-private-job|' + rid;
export const resultAad = (rid, platform) => 'mq-private-result|' + rid + '|' + platform;

export function seal(buf, keyHex, aad) {
  if (!KEY_RE.test(keyHex || '')) throw new Error('private key missing or malformed');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv, { authTagLength: 16 });
  c.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}

export function unseal(blob, keyHex, aad) {
  if (!KEY_RE.test(keyHex || '')) throw new Error('private key missing or malformed');
  if (blob.length < 29) throw new Error('sealed data is truncated');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), blob.subarray(0, 12), { authTagLength: 16 });
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export const sealJob = (job, keyHex, rid) => seal(Buffer.from(JSON.stringify(job)), keyHex, jobAad(rid)).toString('base64');
export function openJob(b64, keyHex, rid) {
  const job = JSON.parse(unseal(Buffer.from(b64, 'base64'), keyHex, jobAad(rid)).toString('utf8'));
  return validateJob(job);
}

// ---- guard: only the origin of the kit-qa site, only paths on it
const hostOk = (h) =>
  h.includes('.') && !/^\d+\.\d+\.\d+\.\d+$/.test(h) && !h.startsWith('[') && !/(^|\.)localhost$/.test(h) && !/\.(local|internal|lan|home|corp)$/.test(h);

export class PrivateInputError extends Error {}

// baseRaw: KITQA_BASE. rawPaths: what the caller typed. Returns { origin, host, paths } (paths start with "/").
export function checkPrivateTarget(baseRaw, rawPaths) {
  let b;
  try {
    b = new URL(baseRaw);
  } catch {
    throw new PrivateInputError('KITQA_BASE is not a URL');
  }
  if (b.protocol !== 'https:') throw new PrivateInputError('private mode needs an https site (the runner cannot reach local or plain-http apps)');
  if (b.username || b.password) throw new PrivateInputError('credentials in the site URL');
  const host = b.hostname.toLowerCase();
  if (!hostOk(host)) throw new PrivateInputError('the site host is not public (the runner cannot reach it)');
  const origin = b.origin;
  if (!rawPaths.length) throw new PrivateInputError('no paths. Usage: kit-qa exec <site> -- node bin/mobile-qa.mjs --private /#sales /#inventory');
  const paths = [];
  for (const raw of rawPaths) {
    let p = String(raw);
    if (p.startsWith(origin + '/')) p = p.slice(origin.length); // a full URL on the same origin is fine
    if (!p.startsWith('/') || p.startsWith('//') || /[\\\s,\u0000-\u001f]/.test(p)) {
      throw new PrivateInputError('refused "' + p.slice(0, 40).replace(host, '<site>') + '": only paths on the kit-qa site (starting with a single /) are allowed');
    }
    let u;
    try {
      u = new URL(p, origin);
    } catch {
      throw new PrivateInputError('refused a malformed path');
    }
    if (u.origin !== origin || u.username || u.password) {
      throw new PrivateInputError('refused a path that leaves the site origin');
    }
    if (!paths.includes(p)) paths.push(p);
  }
  if (paths.length > 12) throw new PrivateInputError('max 12 paths per private call');
  return { origin, host, paths };
}

// Playwright storageState cookies that belong to host (and only those), not expired.
export function cookiesFor(state, host, now = Date.now()) {
  const out = [];
  for (const c of (state && state.cookies) || []) {
    const d = String(c.domain || '').toLowerCase().replace(/^\./, '');
    if (!c.name || typeof c.value !== 'string' || !d) continue;
    if (!(host === d || host.endsWith('.' + d))) continue;
    if (c.expires && c.expires > 0 && c.expires * 1000 < now) continue;
    out.push({ name: c.name, value: c.value, hostOnly: !String(c.domain).startsWith('.'), domain: d, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax', expires: c.expires && c.expires > 0 ? Math.floor(c.expires) : -1 });
  }
  return out;
}

export function buildJob(env, rawPaths, readState = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))) {
  if (env.KITQA_TOKEN || (env.KITQA_URL && !env.KITQA_STORAGE_STATE)) throw new PrivateInputError('token sites (static ?token= URL) are not supported in private mode: only qa-agent sites');
  if (!env.KITQA_BASE || !env.KITQA_STORAGE_STATE) throw new PrivateInputError('private mode runs under kit-qa: kit-qa exec <site> -- node bin/mobile-qa.mjs --private <paths>');
  const t = checkPrivateTarget(env.KITQA_BASE, rawPaths);
  let state;
  try {
    state = readState(env.KITQA_STORAGE_STATE);
  } catch {
    throw new PrivateInputError('cannot read the kit-qa session file');
  }
  const cookies = cookiesFor(state, t.host);
  if (!cookies.length) throw new PrivateInputError('no usable session cookie for this site (run kit-qa login <site>)');
  return { origin: t.origin, host: t.host, job: { v: 1, base: t.origin, paths: t.paths, cookies } };
}

export function validateJob(job) {
  if (!job || job.v !== 1) throw new Error('bad job');
  const t = checkPrivateTarget(job.base, job.paths); // the runner re-checks what it was sent
  const cookies = cookiesFor({ cookies: (job.cookies || []).map((c) => ({ ...c, domain: (c.hostOnly ? '' : '.') + c.domain })) }, t.host);
  if (!cookies.length) throw new Error('job has no cookies for its host');
  return { ...job, base: t.origin, host: t.host, paths: t.paths, cookies, urls: t.paths.map((p) => t.origin + p) };
}

// ---- runner side
// null when this is not a private run. Needs PRIVATE_JOB (sealed), PRIVATE_RID, PRIVATE_QA_KEY from the step env.
export function loadPrivateJob(env = process.env) {
  if (!env.PRIVATE_JOB) return null;
  return openJob(env.PRIVATE_JOB, env.PRIVATE_QA_KEY, env.PRIVATE_RID || '');
}

// Playwright cookie objects (url form so __Host- cookies stay host-only).
export const toPlaywrightCookies = (job) =>
  job.cookies.map((c) => ({ name: c.name, value: c.value, url: job.base + '/', secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, ...(c.expires > 0 ? { expires: c.expires } : {}) }));
// WebDriver "Add Cookie" bodies (no domain: the cookie belongs to the open document's host).
export const toWebDriverCookies = (job) =>
  job.cookies.map((c) => ({ name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, ...(c.expires > 0 ? { expiry: c.expires } : {}) }));

// Log lines a private run may print: page numbers, timings and device names only. Everything else is dropped, so no URL,
// host, cookie, console text or page text can reach the public log, whatever the runner code prints.
const ALLOWED = [
  /^\[\d+\/\d+\]\s*$/,
  /^\s+\d+s (loaded|probed|screen \d+)$/,
  /^\s+(ok|error) in \d+ s, \d+ screens$/,
  /^device [A-Za-z0-9 ._/()|-]+$/,
  /^webdriver session ok \(round \d, \d+ s\)$/,
  /^(ios|android) \| [A-Za-z0-9 ._/()|=-]+$/,
  /^\[private\] [A-Za-z0-9 ._:,()/=-]+$/,
];
export const allowedLine = (s) => ALLOWED.some((r) => r.test(s));

export function installPrivateLogging(job, env = process.env) {
  // Runner-side masking of secrets (defence in depth; the allow-list below is the control).
  const mask = [...job.cookies.map((c) => c.value), env.PRIVATE_QA_KEY].filter((v) => v && v.length >= 8 && !/[\r\n]/.test(v));
  for (const v of mask) process.stdout.write('::add-mask::' + v + '\n');
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    console[k] = (...a) => {
      const s = a.map(String).join(' ').split('\n')[0];
      if (allowedLine(s)) process.stdout.write(s + '\n');
    };
  }
  const fatal = (e) => {
    try {
      fs.mkdirSync('out', { recursive: true });
      fs.writeFileSync('out/fatal.txt', String((e && e.stack) || e));
    } catch {}
    process.stdout.write('[private] fatal error, details are sealed\n');
    process.exit(1);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}

// Seals a results folder into sealed/<platform>/<platform>.enc (tar.gz, then AES-GCM).
export function sealDir(dir, rid, platform, keyHex, outRoot = 'sealed') {
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.readdirSync(dir).length) fs.writeFileSync(path.join(dir, 'note.txt'), 'no results were produced');
  const tgz = path.join(process.env.RUNNER_TEMP || '.', platform + '.private.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, '.']);
  const enc = seal(fs.readFileSync(tgz), keyHex, resultAad(rid, platform));
  fs.rmSync(tgz);
  fs.mkdirSync(path.join(outRoot, platform), { recursive: true });
  fs.writeFileSync(path.join(outRoot, platform, platform + '.enc'), enc);
  return enc.length;
}
