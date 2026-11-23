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
// A background iOS run in flight counts as covering its content for 90 minutes: a second call with the same files
// (a commit's land check, a re-run) does not queue a duplicate Codemagic build. Removed when that run ends.
const pendingFile = (appId) => path.join(cacheDir(appId), 'pending-ios.json');
export function readPendingIos(appId) {
  try {
    const p = JSON.parse(fs.readFileSync(pendingFile(appId), 'utf8'));
    return Date.now() - Date.parse(p.at) < 90 * 60000 ? p.files : null;
  } catch { return null; }
}
export function writePendingIos(appId, files) {
  fs.mkdirSync(cacheDir(appId), { recursive: true });
  fs.writeFileSync(pendingFile(appId), JSON.stringify({ at: new Date().toISOString(), files }));
}
export function clearPendingIos(appId) { fs.rmSync(pendingFile(appId), { force: true }); }

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
    if (flow && flowNames.includes(flow)) {
      light.add(flow);
      if ((map.dark?.flows || darkDefault).includes(flow)) dark.add(flow);
      why.push(f);
      continue;
    }
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

// ---- deciding whether (and where) device QA is worth running (owner 2026-11-23: no wasted QA minutes)

const isLogicTs = (f) => /\.(ts|mts)$/.test(f) && !/\.test\.(ts|mts)$/.test(f);
const union = (a, b) => [...new Set([...a, ...b])].sort();

/**
 * selectFlows, with one extra input: covered = the set of changed-file candidates a green unit test imports directly
 * (the caller proves "green in this run"). A covered plain .ts module (no JSX), not under the map's "all" or "ignore":
 *   - no flow lists it: no device QA for it at all (the unit tests are the check);
 *   - a flow lists it: those flows run on Android only (free), never iOS: the tests cover the logic, the flow checks the
 *     wiring, and when unsure the cheap platform decides.
 * Everything else selects as before, for both platforms. Returns { android, ios, skipped, androidOnly } where android and
 * ios are selectFlows results. Without covered (or a map, or an earlier pass) both are the plain selectFlows result.
 */
export function splitByCoverage(map, changed, flowNames, darkDefault = [], covered = null) {
  const plain = () => { const s = selectFlows(map, changed, flowNames, darkDefault); return { android: s, ios: s, skipped: [], androidOnly: [] }; };
  if (!covered?.size || !map || changed === null) return plain();
  const ignored = anyOf(map.ignore);
  const all = anyOf(map.all);
  const listedBy = (map.rules || []).map((r) => anyOf(r.paths));
  const eligible = changed.filter((f) => covered.has(f) && isLogicTs(f) && !ignored(f) && !all(f) && !f.startsWith('.maestro/'));
  if (!eligible.length) return plain();
  const androidOnly = eligible.filter((f) => listedBy.some((hit) => hit(f)));
  const skipped = eligible.filter((f) => !androidOnly.includes(f));
  const ios = selectFlows(map, changed.filter((f) => !eligible.includes(f)), flowNames, darkDefault);
  const extra = selectFlows(map, androidOnly, flowNames, darkDefault);
  const android = { light: union(ios.light, extra.light), dark: union(ios.dark, extra.dark), why: androidOnly.length ? [ios.light.length || ios.dark.length ? ios.why : '', extra.why + ' (unit-covered: Android only)'].filter(Boolean).join(', ') : ios.why };
  return { android, ios, skipped, androidOnly };
}

/**
 * Is something in `changed` (paths since that platform's last pass; null = no pass yet) a risk that only a real iPhone
 * shows? map.ios = { paths: [globs], content: "regex" }: a changed file matching a glob, or whose current text matches
 * the regex (safe-area, NativeTabs, Glass, fonts ...), or a changed .maestro flow. No map.ios = every change counts.
 * Returns the reason (a file name or phrase) or null. Being wrong costs nothing but timing: iOS then runs at the next
 * land/release instead of now, over everything changed since its last pass.
 */
export function iosRisk(map, changed, appDir, lang = 'en') {
  const vi = lang === 'vi';
  if (changed === null) return vi ? 'chưa có lần iOS nào đạt' : 'no earlier iOS pass';
  if (!map?.ios) return changed.length ? (vi ? 'flows-map.json chưa có luật "ios"' : 'no "ios" rule in flows-map.json') : null;
  const hit = anyOf(map.ios.paths);
  const ignored = anyOf(map.ignore);
  const re = map.ios.content ? new RegExp(map.ios.content) : null;
  for (const f of changed) {
    if (/^\.maestro\/[^/]+\.yaml$/.test(f) || hit(f)) return f;
    if (ignored(f)) continue; // docs, tests and the map itself may mention the patterns without being iOS code
    if (re && appDir) { try { if (re.test(fs.readFileSync(path.join(appDir, f), 'utf8'))) return f + (vi ? ' (mã riêng iOS)' : ' (iOS-specific code)'); } catch { /* deleted or binary */ } }
  }
  return null;
}

const PHRASES = {
  en: {
    skip: { ignored: 'skipped - only tests, docs or maps changed', nothing: 'skipped - nothing changed since the last pass', covered: (f) => 'skipped - pure logic covered by green unit tests (' + f + ')', deferredOnly: (n) => 'skipped - iOS (' + n + ' flows) waits for the land/release step, nothing for Android' },
    android: (n, names) => 'Android ' + n + ' flow' + (n === 1 ? '' : 's') + ' (' + names + ')',
    androidNone: 'Android nothing to run',
    ios: { run: (n, why) => 'iOS ' + n + ' flow' + (n === 1 ? '' : 's') + ' in the background (' + why + ')', defer: 'iOS waits for the land/release step (no iOS-specific change)', none: 'iOS nothing to run' },
  },
  vi: {
    skip: { ignored: 'bỏ qua - chỉ test/tài liệu/map đổi', nothing: 'bỏ qua - không có gì đổi từ lần đạt gần nhất', covered: (f) => 'bỏ qua - logic thuần đã có unit test xanh (' + f + ')', deferredOnly: (n) => 'bỏ qua - iOS (' + n + ' luồng) để tới bước đẩy/phát hành, Android không có gì cần chạy' },
    android: (n, names) => 'Android ' + n + ' luồng (' + names + ')',
    androidNone: 'Android không cần chạy',
    ios: { run: (n, why) => 'iOS ' + n + ' luồng chạy nền (' + why + ')', defer: 'iOS để tới verify:land hoặc phát hành (không có thay đổi riêng iOS)', none: 'iOS không cần chạy' },
  },
};

/**
 * One line saying what was decided and why. d = { androidFlows: [names], ios: { mode: 'run'|'defer'|'none', flows: [names],
 * why }, skipped: [files covered by unit tests], noChange: bool }. Also returns a short parseable code.
 */
export function describeDecision(lang, d) {
  const t = PHRASES[lang] || PHRASES.en;
  const nA = d.androidFlows.length;
  const nI = d.ios.flows.length;
  const code = 'android=' + nA + ' ios=' + (d.ios.mode === 'run' ? nI : d.ios.mode === 'defer' ? 'deferred:' + nI : 0);
  let text;
  if (!nA && d.ios.mode !== 'run') {
    text = d.ios.mode === 'defer' ? t.skip.deferredOnly(nI) : d.skipped.length ? t.skip.covered(d.skipped.slice(0, 3).join(', ')) : d.noChange ? t.skip.nothing : t.skip.ignored;
  } else {
    text = (nA ? t.android(nA, d.androidFlows.join(', ')) : t.androidNone) + '; ' + (d.ios.mode === 'run' ? t.ios.run(nI, d.ios.why) : d.ios.mode === 'defer' ? t.ios.defer : t.ios.none);
  }
  return { text: 'app-qa: ' + text, code };
}
