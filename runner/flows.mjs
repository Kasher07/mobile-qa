// Flows: scripted steps (tap, type, key, back, forward, scroll, swipe, wait, expect, shot) run after the page loads, on both
// phones. This module is shared by the client (validation before anything is sent) and the runners (selectors, the iOS write
// guard, verdicts, summaries). Everything a flow carries is data: selectors and texts reach the browser only through the
// driver's own selector API (Playwright locator / WebDriver find element); nothing here is ever evaluated as code.

export const LIMITS = {
  flows: 6,
  steps: 60,
  stepMs: 30000, // the step itself (its screenshot has a separate 35 s cap)
  flowMs: 240000, // one flow
  waitMsMax: 10000, // {"wait":{"ms":N}}
  waitTimeoutMax: 20000, // default 10000
  textMax: 200,
  selectorMax: 200,
  scrollByMax: 20000,
  shotNameMax: 40,
  jsonBytes: 20000, // a workflow dispatch carries 65535 bytes in all
};

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class FlowError extends Error {}

const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KEYS = ['Enter', 'Tab', 'Backspace', 'Escape'];
const DIRECTIONS = ['up', 'down', 'left', 'right'];
const ACTIONS = ['tap', 'type', 'key', 'back', 'forward', 'scroll', 'swipe', 'wait', 'expect', 'shot'];
// Playwright-only selector engines and pseudo-classes: they would not mean the same on Safari, so a flow may only use plain CSS.
const ENGINE_RE = /^\s*(xpath|text|css|id|data-testid|data-test|data-test-id|role|internal:[a-z-]+|js|nth|>>)\b|^\s*\/\/|>>|internal:|^\s*["'`]|^\s*\.\./i;
const PSEUDO_RE = /:(has-text|text|text-is|text-matches|visible|nth-match|right-of|left-of|above|below|near|light|is-visible)\b/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const fail = (where, msg) => {
  throw new FlowError(where + ': ' + msg);
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function checkSelector(sel, where, { textGuard } = {}) {
  if (typeof sel !== 'string' || !sel.trim()) fail(where, 'selector must be a non-empty string');
  if (sel.length > LIMITS.selectorMax) fail(where, 'selector longer than ' + LIMITS.selectorMax + ' characters');
  if (CONTROL_RE.test(sel)) fail(where, 'selector has control characters');
  if (ENGINE_RE.test(sel) || PSEUDO_RE.test(sel)) fail(where, 'only plain CSS selectors are allowed (no text=, xpath=, >>, :has-text ...): use {"text": "..."} for visible text');
  if (textGuard) {
    const why = textGuard(sel);
    if (why) fail(where, why);
  }
  return sel.trim();
}
export function checkText(t, where, { textGuard } = {}) {
  if (typeof t !== 'string' || !t.length) fail(where, 'text must be a non-empty string');
  if (t.length > LIMITS.textMax) fail(where, 'text longer than ' + LIMITS.textMax + ' characters');
  if (CONTROL_RE.test(t)) fail(where, 'text has control characters');
  if (textGuard) {
    const why = textGuard(t);
    if (why) fail(where, why);
  }
  return t;
}

// A target is a CSS string, {"selector": css} or {"text": visible text}.
export function parseTarget(v, where, opts) {
  if (typeof v === 'string') return { css: checkSelector(v, where, opts) };
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === 'selector') return { css: checkSelector(v.selector, where, opts) };
    if (keys.length === 1 && keys[0] === 'text') return { text: checkText(v.text, where, opts).replace(/\s+/g, ' ').trim() };
  }
  return fail(where, 'target must be a CSS string, {"selector": "..."} or {"text": "..."}');
}
const onlyKeys = (o, allowed, where) => {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(where, 'unknown key "' + k + '"');
};
const intIn = (v, min, max, where, what) => {
  if (!Number.isInteger(v) || v < min || v > max) fail(where, what + ' must be an integer ' + min + '..' + max);
  return v;
};
const frac = (p, where) => {
  if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && n >= 0 && n <= 1)) fail(where, 'a point is [x, y] as fractions 0..1 of the screen');
  return p;
};

// One step -> { do, ...fields }. The flow author never writes "do": a step is an object with exactly one action key.
export function parseStep(raw, where, opts = {}) {
  if (!isObj(raw)) fail(where, 'a step is an object like {"tap": "#go"}');
  const keys = Object.keys(raw).filter((k) => k !== 'note');
  if (raw.note !== undefined && typeof raw.note !== 'string') fail(where + '.note', 'a note must be a string');
  if (raw.note !== undefined) checkText(raw.note, where + '.note', opts);
  if (keys.length !== 1) fail(where, 'a step has exactly one action key (' + ACTIONS.join(', ') + ')');
  const act = keys[0];
  const v = raw[act];
  const w = where + '.' + act;
  const note = raw.note === undefined ? undefined : raw.note.slice(0, 80);
  const out = (o) => (note ? { ...o, note } : o);
  switch (act) {
    case 'tap':
      return out({ do: 'tap', target: parseTarget(v, w, opts) });
    case 'type': {
      if (!isObj(v)) fail(w, 'use {"selector": "...", "text": "..."}');
      onlyKeys(v, ['selector', 'text', 'clear'], w);
      return out({ do: 'type', target: { css: checkSelector(v.selector, w + '.selector', opts) }, text: checkText(v.text, w + '.text', opts), clear: v.clear === true });
    }
    case 'key':
      if (!KEYS.includes(v)) fail(w, 'key must be one of ' + KEYS.join(', '));
      return out({ do: 'key', key: v });
    case 'back':
    case 'forward':
      if (v !== true) fail(w, 'write {"' + act + '": true}');
      return out({ do: act });
    case 'scroll': {
      if (!isObj(v)) fail(w, 'use {"to": target} or {"by": pixels}');
      onlyKeys(v, ['to', 'by'], w);
      if ((v.to === undefined) === (v.by === undefined)) fail(w, 'give exactly one of "to" and "by"');
      if (v.to !== undefined) return out({ do: 'scroll', target: parseTarget(v.to, w + '.to', opts) });
      return out({ do: 'scroll', by: intIn(v.by, -LIMITS.scrollByMax, LIMITS.scrollByMax, w, '"by"') });
    }
    case 'swipe': {
      if (!isObj(v)) fail(w, 'use {"on": target, "direction": "left"} or {"from": [x, y], "to": [x, y]}');
      onlyKeys(v, ['on', 'direction', 'from', 'to'], w);
      if (v.direction !== undefined) {
        if (!DIRECTIONS.includes(v.direction)) fail(w, 'direction must be ' + DIRECTIONS.join(', '));
        if (v.from !== undefined || v.to !== undefined) fail(w, 'give direction (with "on") or from/to, not both');
        return out({ do: 'swipe', target: v.on === undefined ? null : parseTarget(v.on, w + '.on', opts), direction: v.direction });
      }
      if (v.on !== undefined) fail(w, '"on" needs "direction"');
      return out({ do: 'swipe', from: frac(v.from, w + '.from'), to: frac(v.to, w + '.to') });
    }
    case 'wait': {
      if (!isObj(v)) fail(w, 'use {"ms": N} or {"selector"|"text": ..., "state": "visible"|"gone"}');
      onlyKeys(v, ['ms', 'selector', 'text', 'state', 'timeout'], w);
      if (v.ms !== undefined) {
        if (v.selector !== undefined || v.text !== undefined) fail(w, 'give ms or a target, not both');
        return out({ do: 'wait', ms: intIn(v.ms, 0, LIMITS.waitMsMax, w, '"ms"') });
      }
      const t = parseTarget(v.selector !== undefined ? { selector: v.selector } : v.text !== undefined ? { text: v.text } : null, w, opts);
      if (v.selector !== undefined && v.text !== undefined) fail(w, 'give selector or text, not both');
      const state = v.state === undefined ? 'visible' : v.state;
      if (state !== 'visible' && state !== 'gone') fail(w, 'state must be visible or gone');
      const timeout = v.timeout === undefined ? 10000 : intIn(v.timeout, 100, LIMITS.waitTimeoutMax, w, '"timeout"');
      return out({ do: 'wait', target: t, state, timeout });
    }
    case 'expect': {
      if (!isObj(v)) fail(w, 'use {"selector"|"text": ..., "visible": true|false | "count": N | "inViewport": true}');
      onlyKeys(v, ['selector', 'text', 'visible', 'count', 'inViewport'], w);
      if (v.selector !== undefined && v.text !== undefined) fail(w, 'give selector or text, not both');
      const t = parseTarget(v.selector !== undefined ? { selector: v.selector } : v.text !== undefined ? { text: v.text } : null, w, opts);
      const what = ['visible', 'count', 'inViewport'].filter((k) => v[k] !== undefined);
      if (what.length !== 1) fail(w, 'give exactly one of visible, count, inViewport');
      if (what[0] === 'count') return out({ do: 'expect', target: t, count: intIn(v.count, 0, 1000, w, '"count"') });
      if (typeof v[what[0]] !== 'boolean') fail(w, '"' + what[0] + '" must be true or false');
      return out({ do: 'expect', target: t, [what[0]]: v[what[0]] });
    }
    case 'shot': {
      if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(v)) fail(w, 'a shot name is 1-40 letters, digits, - or _');
      if (opts.textGuard && opts.textGuard(v)) fail(w, 'a shot name ' + opts.textGuard(v));
      return out({ do: 'shot', name: v });
    }
    default:
      return fail(where, 'unknown action "' + act + '" (' + ACTIONS.join(', ') + ')');
  }
}

// doc: { flows: [{ name, start, steps }], allowWrites?: "reason" }. mode public: start is a URL checked by checkStart (the
// caller's public-URL rules); mode private: start is a path on the site. Returns { allowWrites, noWrites, flows, wireJson }.
export function parseFlows(doc, { checkStart, textGuard, noWrites = false } = {}) {
  if (!isObj(doc)) fail('steps file', 'must be an object {"flows": [...]}');
  onlyKeys(doc, ['flows', 'allowWrites', 'noWrites'], 'steps file');
  // A write-protected session (kit-qa --mint sets KITQA_NO_WRITES=1; the flag then travels in the steps) never opts out of the guard.
  const protectedRun = noWrites === true || doc.noWrites === true;
  if (protectedRun && doc.allowWrites !== undefined) fail('allowWrites', 'refused: this session is write-protected (KITQA_NO_WRITES=1), flows cannot opt out of the no-writes guard');
  if (!Array.isArray(doc.flows) || !doc.flows.length) fail('steps file', '"flows" must be a non-empty array');
  if (doc.flows.length > LIMITS.flows) fail('steps file', 'max ' + LIMITS.flows + ' flows per file');
  let allowWrites = null;
  if (doc.allowWrites !== undefined) {
    if (typeof doc.allowWrites !== 'string' || !doc.allowWrites.trim()) fail('allowWrites', 'needs a non-empty reason');
    allowWrites = checkText(doc.allowWrites.trim(), 'allowWrites', { textGuard });
  }
  const seen = new Set();
  const wire = [];
  const flows = doc.flows.map((f, i) => {
    const where = 'flow ' + (i + 1);
    if (!isObj(f)) fail(where, 'must be an object');
    onlyKeys(f, ['name', 'start', 'steps'], where);
    if (!NAME_RE.test(f.name || '')) fail(where, 'name must be 1-40 letters, digits, - or _');
    if (seen.has(f.name)) fail(where, 'duplicate flow name "' + f.name + '"');
    if (textGuard && textGuard(f.name)) fail(where, 'the flow name ' + textGuard(f.name) + ' (names are printed in the public log)');
    seen.add(f.name);
    if (typeof f.start !== 'string' || !f.start) fail(where, 'start is required (a URL in public mode, a path in private mode)');
    const start = checkStart ? checkStart(f.start, where) : f.start;
    if (!Array.isArray(f.steps) || !f.steps.length) fail(where, '"steps" must be a non-empty array');
    if (f.steps.length > LIMITS.steps) fail(where, 'max ' + LIMITS.steps + ' steps per flow');
    const steps = f.steps.map((s, j) => parseStep(s, where + ' step ' + (j + 1), { textGuard }));
    wire.push({ name: f.name, start, steps: f.steps });
    return { name: f.name, start, steps };
  });
  // "wire" is what travels (authoring form, so the runner validates it again with the same rules); "flows" is the parsed form.
  const wireJson = JSON.stringify({ flows: wire, ...(allowWrites ? { allowWrites } : {}), ...(protectedRun ? { noWrites: true } : {}) });
  if (Buffer.byteLength(wireJson) > LIMITS.jsonBytes) fail('steps file', 'too large to send (max ' + LIMITS.jsonBytes + ' bytes)');
  return { allowWrites, noWrites: protectedRun, flows, wireJson };
}

// ---- targets, shared by both drivers
export function xpathLiteral(s) {
  if (!s.includes("'")) return "'" + s + "'";
  if (!s.includes('"')) return '"' + s + '"';
  return 'concat(' + s.split("'").map((p) => "'" + p + "'").join(',"\'",') + ')';
}
// The deepest element whose normalised text contains the text (so a button wins over the card around it).
export const textXPath = (t) => {
  const lit = xpathLiteral(t);
  return '//*[not(self::script or self::style or self::noscript or self::head or self::title)][contains(normalize-space(.), ' + lit + ')][not(*[contains(normalize-space(.), ' + lit + ')])]';
};
export const describeTarget = (t) => (!t ? 'screen' : t.css !== undefined ? t.css : '"' + t.text + '"');

export function stepLabel(s) {
  const t = s.target;
  switch (s.do) {
    case 'tap': return 'tap ' + describeTarget(t);
    case 'type': return 'type into ' + describeTarget(t) + ' (' + s.text.length + ' characters)';
    case 'key': return 'key ' + s.key;
    case 'back': return 'back';
    case 'forward': return 'forward';
    case 'scroll': return s.target ? 'scroll to ' + describeTarget(t) : 'scroll by ' + s.by + ' px';
    case 'swipe': return s.direction ? 'swipe ' + s.direction + ' on ' + describeTarget(t) : 'swipe from [' + s.from + '] to [' + s.to + ']';
    case 'wait': return s.ms !== undefined ? 'wait ' + s.ms + ' ms' : 'wait for ' + describeTarget(t) + ' ' + s.state;
    case 'expect': return 'expect ' + describeTarget(t) + (s.count !== undefined ? ' count=' + s.count : s.inViewport !== undefined ? ' inViewport=' + s.inViewport : ' visible=' + s.visible);
    case 'shot': return 'shot ' + s.name;
    default: return s.do;
  }
}

// Swipe geometry in fractions of the screen: the finger moves OPPOSITE to the scroll direction ("left" = content moves left).
export function swipePoints(direction, rect) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = rect.w * 0.35;
  const dy = rect.h * 0.35;
  const m = { left: [[cx + dx, cy], [cx - dx, cy]], right: [[cx - dx, cy], [cx + dx, cy]], up: [[cx, cy + dy], [cx, cy - dy]], down: [[cx, cy - dy], [cx, cy + dy]] };
  const [a, b] = m[direction];
  return { from: { x: Math.round(a[0]), y: Math.round(a[1]) }, to: { x: Math.round(b[0]), y: Math.round(b[1]) } };
}

export const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);

// ---- iOS write guard: runs in the page through WebDriver "Execute Script" (safaridriver has no run-at-document-start hook).
// Blocks, for every origin: fetch and XHR whose method is not exactly GET/HEAD/OPTIONS (an XHR whose method it never saw counts as
// a write), sendBeacon, form submissions whose method is not GET, and WebSockets. Records what it blocked in a per-run, random,
// non-enumerable property (window[KEY]) that the page does not know; idempotent per document. It is a JavaScript guard: see the
// README for everything it does not cover.
function guardBody(KEY) {
  if (window[KEY]) return { ok: true, already: true };
  var blocked = [];
  var rec = function (what) { if (blocked.length < 50) blocked.push(String(what).slice(0, 60)); };
  var readOnly = function (m) { return m === 'GET' || m === 'HEAD' || m === 'OPTIONS'; };
  Object.defineProperty(window, KEY, { value: { blocked: blocked }, enumerable: false });
  var realFetch = window.fetch;
  if (realFetch) {
    window.fetch = function (input, init) {
      var m = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
      if (!readOnly(m)) { rec('fetch ' + m); return Promise.reject(new TypeError('mobile-qa write guard: ' + m + ' blocked')); }
      return realFetch.apply(this, arguments);
    };
  }
  var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XP) {
    var methods = new WeakMap();
    var realOpen = XP.open;
    var realSend = XP.send;
    XP.open = function (m) { methods.set(this, String(m).toUpperCase()); return realOpen.apply(this, arguments); };
    XP.send = function () {
      var m = methods.get(this);
      if (!readOnly(m)) {
        rec('xhr ' + m);
        var x = this;
        setTimeout(function () { x.dispatchEvent(new Event('error')); x.dispatchEvent(new Event('loadend')); }, 0);
        return;
      }
      return realSend.apply(this, arguments);
    };
  }
  if (navigator.sendBeacon) navigator.sendBeacon = function () { rec('beacon'); return false; };
  var formWrites = function (f, submitter) {
    var m = String((submitter && submitter.formMethod) || f.method || 'get').toLowerCase();
    return m !== 'get' && m !== 'dialog';
  };
  document.addEventListener('submit', function (e) {
    if (formWrites(e.target, e.submitter)) { e.preventDefault(); e.stopImmediatePropagation(); rec('form ' + (e.target.method || 'post')); }
  }, true);
  var realSubmit = window.HTMLFormElement && HTMLFormElement.prototype.submit;
  if (realSubmit) HTMLFormElement.prototype.submit = function () { if (formWrites(this, null)) { rec('form.submit'); return; } return realSubmit.apply(this, arguments); };
  if (window.WebSocket) window.WebSocket = function () { rec('websocket'); throw new DOMException('mobile-qa write guard: WebSockets are blocked', 'SecurityError'); };
  return { ok: true, already: false };
}
export const guardSource = (key) => 'return (' + guardBody.toString() + ')(' + JSON.stringify(key) + ');';
export const guardCheck = (key) => 'return !!window[' + JSON.stringify(key) + '];';
export const guardRead = (key) => 'var g = window[' + JSON.stringify(key) + ']; return g ? g.blocked.slice() : null;';
export const newGuardKey = () => '__mq' + randomBytes(9).toString('hex');

// ---- verdict and summary (client side; the runner only records facts)
export function flowVerdict(f) {
  const bad = [];
  const notes = [];
  if (f.error) bad.push('ERROR ' + f.error);
  for (const s of f.steps || []) if (!s.ok && !s.skipped) bad.push('step ' + s.i + ' (' + s.label + '): ' + (s.error || 'failed'));
  if (!f.error && !(f.steps || []).some((s) => s.ok || !s.skipped)) bad.push('no step ran');
  const skipped = (f.steps || []).filter((s) => s.skipped).length;
  if (skipped) notes.push(skipped + ' step(s) not run after the failure');
  const pr = f.probe;
  if (!pr && !f.error) bad.push('no end-state layout probe');
  if (pr) {
    if (pr.overflowX) bad.push('horizontal overflow at the end state ' + pr.scrollWidth + '>' + pr.innerWidth + ' [' + (pr.wide || []).slice(0, 3).join('; ') + ']');
    if ((pr.smallTapTargets || []).length) notes.push(pr.smallTapTargets.length + ' tap targets <24px at the end state');
  }
  if (f.allowWrites) notes.push('writes ALLOWED: ' + f.allowWrites);
  else if (!f.guard || !f.guard.active) bad.push('write guard not active: the flow must not run without it');
  if (f.guard && f.guard.failed) bad.push('write guard missing on ' + f.guard.failed + ' document(s)');
  if ((f.blocked || []).length) notes.push((f.blocked || []).length + ' write(s) blocked: ' + (f.blocked || []).slice(0, 4).join(', '));
  for (const n of f.notes || []) notes.push(n);
  return { bad, notes };
}

// Page- and runner-controlled text: no control, invisible or bidi characters, bounded (same rules as the private-mode sanitiser).
export const clean = (s, max = 300) =>
  String(s ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/[\p{Cf}\p{Co}\p{Cn}\p{Cs}]+/gu, '')
    .slice(0, max);

// The number of flow results must match what was asked, unless the runner said why not (iOS under KITQA_NO_WRITES).
export function flowCountIssue(res, requested) {
  const got = Array.isArray(res.flows) ? res.flows.length : 0;
  if (res.flowsSkipped) return null;
  return got < requested ? 'only ' + got + ' of ' + requested + ' flow result(s) came back' : null;
}

export function renderFlowSummary(platform, f, { T = clean } = {}) {
  const v = flowVerdict(f);
  const L = ['# flow ' + f.name + ' on ' + platform + ': ' + (v.bad.length ? 'FAILED' : 'passed'), ''];
  L.push('start: ' + T(f.startShown || f.start || '?'), 'time: ' + Math.round((f.ms || 0) / 1000) + ' s', '');
  if (f.guard) L.push('write guard: ' + T(f.guard.how || '') + (f.guard.documents !== undefined ? ' (' + f.guard.documents + ' document(s), ' + (f.guard.late || 0) + ' guarded after load)' : ''), '');
  if (f.allowWrites) L.push('WRITES ALLOWED: ' + T(f.allowWrites, 200), '');
  L.push('| # | step | result | ms | how | screenshot |', '|---|------|--------|----|-----|------------|');
  for (const s of f.steps || []) {
    L.push('| ' + s.i + ' | ' + T(s.label).replace(/\|/g, '/') + ' | ' + (s.skipped ? 'not run' : s.ok ? 'ok' : 'FAILED: ' + T(s.error || '', 160).replace(/\|/g, '/')) + ' | ' + (s.ms ?? '') + ' | ' + T(s.via || '', 60).replace(/\|/g, '/') + (s.kb === true ? ', keyboard up' : '') + ' | ' + (s.shot || '') + ' |');
  }
  L.push('');
  for (const b of v.bad) L.push('ISSUE: ' + T(b, 300));
  for (const n of v.notes) L.push('note: ' + T(n, 300));
  return L.join('\n');
}

// Client side: writes <dir>/flows/<name>/summary.md for every flow of one platform's results and returns the lines for the main
// summary plus the number of issues. T cleans untrusted text (private runs); the shot paths are re-sanitised here.
export function reportFlows(res, dir, { T = clean } = {}) {
  const lines = [];
  let issues = 0;
  for (const f of (Array.isArray(res.flows) ? res.flows : []).slice(0, LIMITS.flows)) {
    const name = fileSafe(f && f.name);
    f.steps = (Array.isArray(f.steps) ? f.steps : []).slice(0, LIMITS.steps);
    for (const s of f.steps) if (s.shot) s.shot = String(s.shot).replace(/[^A-Za-z0-9._/-]/g, '_');
    const v = flowVerdict(f);
    issues += v.bad.length;
    const md = renderFlowSummary(res.platform, { ...f, name }, { T });
    const fdir = path.join(dir, 'flows', name);
    fs.mkdirSync(fdir, { recursive: true });
    fs.writeFileSync(path.join(fdir, 'summary.md'), md);
    lines.push('- flow ' + name + ' :: ' + (v.bad.length ? 'ISSUES: [untrusted] ' + T(v.bad.join(' | '), 400) : 'ok (' + f.steps.filter((s) => s.ok).length + '/' + f.steps.length + ' steps)') + (v.notes.length ? ' [untrusted] (' + T(v.notes.join(', '), 300) + ')' : ''));
    lines.push('  - summary: ' + path.join(fdir, 'summary.md'));
    for (const s of f.steps) if (s.shot) lines.push('  - ' + path.join(dir, s.shot));
  }
  return { lines, issues };
}

// ---- runner side: the flows of this job (public: the FLOWS workflow input; private: inside the sealed job).
export function loadRunnerFlows({ publicJson, privateDoc, base }) {
  const src = privateDoc || (publicJson && publicJson.trim() ? JSON.parse(publicJson) : null);
  if (!src) return null;
  const checkStart = (s, where) => {
    if (base) {
      if (!s.startsWith('/') || s.startsWith('//')) fail(where, 'start must be a path on the site');
      if (new URL(s, base).origin !== new URL(base).origin) fail(where, 'start leaves the site');
      return s;
    }
    let u;
    try {
      u = new URL(s);
    } catch {
      return fail(where, 'start is not a URL');
    }
    if (!/^https?:$/.test(u.protocol)) fail(where, 'start must be http(s)');
    return u.href;
  };
  const doc = parseFlows(src, { checkStart });
  return { allowWrites: doc.allowWrites, noWrites: doc.noWrites, flows: doc.flows.map((f) => ({ ...f, startShown: f.start, start: base ? new URL(f.start, base).href : f.start })) };
}
