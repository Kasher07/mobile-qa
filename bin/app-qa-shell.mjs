// Reuse of an earlier release build (the "shell") when only JavaScript changed. The key is the Expo native
// fingerprint (native code, config, native packages, patches) plus a hash of every media file the JS bundle carries
// (images, fonts, databases...), so a change to any of them forces a full native build. Shells live on this machine
// only (never in the public repo), encrypted per run like the app when they travel.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Bump when the runner's build or JS-replacement recipe changes, so old shells are not reused. */
export const RECIPE = '1';
const MEDIA = /\.(png|jpe?g|gif|webp|bmp|svg|ttf|otf|woff2?|db|sqlite|mp3|mp4|m4a|wav|aac|json|lottie|html|pdf)$/i;
const KEEP = 2;

/** Expo fingerprint hash of the project, or null when it cannot be computed (no node_modules). */
export function nativeFingerprint(appDir) {
  const cli = path.join(appDir, 'node_modules', '@expo', 'fingerprint', 'bin', 'cli.js');
  if (!fs.existsSync(cli)) return null;
  try {
    const out = execFileSync(process.execPath, [cli, appDir], { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
    const hash = JSON.parse(out).hash;
    return /^[0-9a-f]{20,}$/.test(hash) ? hash : null;
  } catch {
    return null;
  }
}

/** Hash of the media files among `files` (paths relative to appDir), content included. JS/TS sources are excluded. */
export function mediaHash(appDir, files) {
  const h = createHash('sha256');
  for (const f of [...files].filter((x) => MEDIA.test(x) && !/(^|\/)(package(-lock)?|tsconfig.*|app|eas)\.json$/.test(x) && !x.startsWith('.maestro/')).sort()) {
    h.update(f + '\0');
    h.update(fs.readFileSync(path.join(appDir, f)));
  }
  return h.digest('hex');
}

export function shellKey(fingerprint, media) {
  return fingerprint ? createHash('sha256').update(RECIPE + '|' + fingerprint + '|' + media).digest('hex').slice(0, 32) : null;
}

export function cacheDir(appId) {
  const base = process.env.APP_QA_CACHE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.cache'), 'kit-app-qa');
  return path.join(base, appId.replace(/[^A-Za-z0-9.]/g, '_'));
}

export function findShell(appId, platform, key) {
  if (!key) return null;
  const f = path.join(cacheDir(appId), platform + '-' + key + '.tgz');
  return fs.existsSync(f) ? f : null;
}

/** Moves a freshly built shell into the cache and keeps the newest few per platform. */
export function storeShell(appId, platform, key, file) {
  if (!key || !fs.existsSync(file)) return null;
  const dir = cacheDir(appId);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, platform + '-' + key + '.tgz');
  fs.copyFileSync(file, dest);
  fs.rmSync(file);
  const old = fs.readdirSync(dir).filter((f) => f.startsWith(platform + '-') && f.endsWith('.tgz'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP);
  for (const o of old) fs.rmSync(path.join(dir, o.f), { force: true });
  return dest;
}
