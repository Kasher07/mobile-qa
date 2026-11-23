// Which flows a change needs. Each platform remembers the content of every app file at its last passing run
// (last-pass-<platform>.json in the shell cache folder); the files that differ now are matched against the app's
// .maestro/flows-map.json:
//   { "ignore": [globs], "all": [globs], "rules": [{ "paths": [globs], "flows": [names] }],
//     "dark": { "paths": [globs], "flows": [names] } }
// A changed .maestro/<flow>.yaml selects that flow. A changed file that no rule names, or one under "all", selects
// every flow (unknown means "could touch anything"). Ignored files (docs, unit tests, web-only code) select nothing.
// Without a map every change selects every flow.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { cacheDir } from './app-qa-shell.mjs';

/** Glob to RegExp: ** (any depth), * (one segment), ? and {a,b}. Paths use forward slashes. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') { re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += glob[i + 2] === '/' ? 2 : 1; }
    else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '{') { const end = glob.indexOf('}', i); re += '(?:' + glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = end; }
    else re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const anyOf = (globs) => { const rs = (globs || []).map(globToRegExp); return (f) => rs.some((r) => r.test(f)); };

/** Content hash of each file (relative paths). */
export function snapshot(appDir, files) {
  const out = {};
  for (const f of files) out[f] = createHash('sha1').update(fs.readFileSync(path.join(appDir, f))).digest('hex');
  return out;
}

export function changedSince(prev, cur) {
  if (!prev) return null; // never passed: everything counts as changed
  const names = new Set([...Object.keys(prev), ...Object.keys(cur)]);
  return [...names].filter((f) => prev[f] !== cur[f]).sort();
}

const passFile = (appId, platform) => path.join(cacheDir(appId), 'last-pass-' + platform + '.json');
export function readLastPass(appId, platform) {
  try { return JSON.parse(fs.readFileSync(passFile(appId, platform), 'utf8')).files; } catch { return null; }
}
export function writeLastPass(appId, platform, files) {
  fs.mkdirSync(cacheDir(appId), { recursive: true });
  fs.writeFileSync(passFile(appId, platform), JSON.stringify({ at: new Date().toISOString(), files }));
}

/**
 * changed: list of paths, or null (no earlier pass). Returns { light, dark, why } with flow names; empty light and
 * dark = nothing to QA.
 */
export function selectFlows(map, changed, flowNames, darkDefault = []) {
  const every = { light: [...flowNames].sort(), dark: [...darkDefault] };
  if (changed === null) return { ...every, why: 'no earlier passing run on this machine' };
  if (!map) return changed.length ? { ...every, why: 'no .maestro/flows-map.json' } : { light: [], dark: [], why: 'nothing changed' };
  const ignored = anyOf(map.ignore);
  const all = anyOf(map.all);
  const rules = (map.rules || []).map((r) => ({ hit: anyOf(r.paths), flows: r.flows }));
  const darkHit = anyOf(map.dark?.paths);
  const light = new Set();
  const dark = new Set();
  const why = [];
  for (const f of changed) {
    const flow = /^\.maestro\/(.+)\.yaml$/.exec(f)?.[1];
    if (flow && flowNames.includes(flow)) { light.add(flow); why.push(f); continue; }
    if (ignored(f)) continue;
    if (all(f)) return { ...every, dark: map.dark?.flows || darkDefault, why: f + ' affects every screen' };
    const hits = rules.filter((r) => r.hit(f));
    if (!hits.length) return { ...every, why: f + ' is not in .maestro/flows-map.json' };
    for (const r of hits) for (const x of r.flows) light.add(x);
    if (darkHit(f)) for (const x of map.dark.flows) dark.add(x);
    why.push(f);
  }
  return { light: [...light].filter((x) => flowNames.includes(x)).sort(), dark: [...dark].filter((x) => flowNames.includes(x)), why: why.length ? why.join(', ') : 'only ignored files changed' };
}
