import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFlows, parseStep, FlowError, LIMITS, xpathLiteral, textXPath, swipePoints, stepLabel, flowVerdict, renderFlowSummary, reportFlows, GUARD_SOURCE, loadRunnerFlows } from '../runner/flows.mjs';
import { textGuard, readFlows, parseArgs } from '../bin/mobile-qa.mjs';
import { buildJob, validateJob, privateFlows, allowedLine, checkPrivateTarget } from '../runner/private.mjs';

const doc = (steps, extra = {}) => ({ flows: [{ name: 'f', start: 'https://a.com/x', steps }], ...extra });
const ok = (steps) => parseFlows(doc(steps), {});
const bad = (steps, re, extra) => assert.throws(() => parseFlows(doc(steps, extra), {}), (e) => e instanceof FlowError && re.test(e.message), JSON.stringify(steps));

test('every step kind parses', () => {
  const r = ok([
    { tap: '#go' }, { tap: { text: 'Save' } }, { type: { selector: '#q', text: 'hello', clear: true } }, { key: 'Enter' }, { back: true }, { forward: true },
    { scroll: { to: '#x' } }, { scroll: { by: -300 } }, { swipe: { on: '.car', direction: 'left' } }, { swipe: { from: [0.8, 0.5], to: [0.2, 0.5] } },
    { wait: { ms: 500 } }, { wait: { selector: '#x', state: 'gone', timeout: 3000 } }, { wait: { text: 'Done' } },
    { expect: { selector: '#x', visible: true } }, { expect: { text: 'Saved', visible: false } }, { expect: { selector: 'li', count: 3 } }, { expect: { selector: '#i', inViewport: true } },
    { shot: 'after-save' },
  ]);
  assert.equal(r.flows[0].steps.length, 18);
  assert.equal(r.flows[0].steps[0].do, 'tap');
  assert.deepEqual(r.flows[0].steps[1].target, { text: 'Save' });
  assert.ok(JSON.parse(r.wireJson).flows[0].steps[0].tap === '#go', 'the wire form keeps the authoring steps');
});

test('bad steps are refused with a reason', () => {
  bad([{}], /exactly one action/);
  bad([{ tap: '#a', back: true }], /exactly one action/);
  bad([{ hover: '#a' }], /unknown action/);
  bad([{ tap: '' }], /non-empty/);
  bad([{ tap: 'text=Save' }], /plain CSS/);
  bad([{ tap: '//div' }], /plain CSS/);
  bad([{ tap: 'a >> b' }], /plain CSS/);
  bad([{ tap: 'button:has-text("x")' }], /plain CSS/);
  bad([{ tap: 'x'.repeat(201) }], /longer than/);
  bad([{ tap: 'a\u0000b' }], /control/);
  bad([{ key: 'F5' }], /key must be/);
  bad([{ back: 1 }], /"back": true/);
  bad([{ swipe: { direction: 'left', from: [0, 0], to: [1, 1] } }], /not both/);
  bad([{ swipe: { from: [0, 0], to: [2, 1] } }], /fractions/);
  bad([{ wait: { ms: LIMITS.waitMsMax + 1 } }], /integer/);
  bad([{ wait: { selector: '#a', timeout: 999999 } }], /"timeout"/);
  bad([{ wait: { selector: '#a', state: 'maybe' } }], /state/);
  bad([{ expect: { selector: '#a' } }], /exactly one of/);
  bad([{ expect: { selector: '#a', visible: true, count: 1 } }], /exactly one of/);
  bad([{ expect: { selector: '#a', visible: 'yes' } }], /true or false/);
  bad([{ shot: 'a b' }], /shot name/);
  bad([{ type: { selector: '#a' } }], /text/);
  bad([{ type: { selector: '#a', text: 'x', into: 1 } }], /unknown key/);
  bad([{ scroll: { to: '#a', by: 3 } }], /exactly one/);
  bad([{ tap: '#a' }], /allowWrites/, { allowWrites: '   ' });
});

test('limits: flows, steps, names, size', () => {
  const many = Array.from({ length: LIMITS.steps + 1 }, () => ({ key: 'Tab' }));
  assert.throws(() => parseFlows(doc(many), {}), /max 60 steps/);
  const flows = Array.from({ length: LIMITS.flows + 1 }, (_, i) => ({ name: 'f' + i, start: 'https://a.com/', steps: [{ key: 'Tab' }] }));
  assert.throws(() => parseFlows({ flows }, {}), /max 6 flows/);
  assert.throws(() => parseFlows({ flows: [{ name: 'a/b', start: 'https://a.com/', steps: [{ key: 'Tab' }] }] }, {}), /name must be/);
  assert.throws(() => parseFlows({ flows: [{ name: 'a', start: 'https://a.com/', steps: [{ key: 'Tab' }] }, { name: 'a', start: 'https://a.com/', steps: [{ key: 'Tab' }] }] }, {}), /duplicate/);
  assert.throws(() => parseFlows({ flows: [], x: 1 }, {}), /unknown key/);
  assert.throws(() => parseFlows(doc([{ type: { selector: '#a', text: 'x'.repeat(LIMITS.textMax + 1) } }]), {}), /longer than/);
  const fat = Array.from({ length: 6 }, (_, i) => ({ name: 'f' + i, start: 'https://a.com/', steps: Array.from({ length: 60 }, () => ({ tap: { text: 't'.repeat(100) } })) }));
  assert.throws(() => parseFlows({ flows: fat }, {}), /too large/);
});

test('public mode refuses secret-looking and personal text', () => {
  for (const t of ['eyJhbGciOiJIUzI1NiJ9.abcdefghijk', 'a8f9c2d7e6b5a4f3c2d1e0f9', 'me@example.com', 'my key is a8f9c2d7e6b5a4f3c2d1e0f9 ok', '0123456789abcdef0123456789abcdef']) {
    assert.ok(textGuard(t), t + ' should be refused');
    assert.throws(() => parseFlows(doc([{ type: { selector: '#a', text: t } }]), { textGuard }), /secret|personal/);
  }
  for (const t of ['hello world', 'Nguyen Van A', 'Save changes', '12345']) assert.equal(textGuard(t), null, t);
  assert.throws(() => parseFlows(doc([{ tap: '#a' }], { allowWrites: 'token a8f9c2d7e6b5a4f3c2d1e0f9' }), { textGuard }), /secret/);
});

test('public start URLs go through the public URL rules', () => {
  const f = fs.mkdtempSync(path.join(os.tmpdir(), 'mqf-'));
  const w = (d) => { const p = path.join(f, 'x.json'); fs.writeFileSync(p, JSON.stringify(d)); return p; };
  const good = readFlows(w(doc([{ tap: '#a' }])));
  assert.equal(good.flows[0].start, 'https://a.com/x');
  assert.throws(() => readFlows(w({ flows: [{ name: 'a', start: 'https://a.com/?token=1', steps: [{ key: 'Tab' }] }] })), /refused start URL/);
  assert.throws(() => readFlows(w({ flows: [{ name: 'a', start: 'http://localhost:3000/', steps: [{ key: 'Tab' }] }] })), /refused start URL/);
  assert.equal(readFlows(w(doc([{ tap: '#a' }])), { allowWrites: 'fixture' }).allowWrites, 'fixture');
  fs.writeFileSync(path.join(f, 'bad.json'), '{nope');
  assert.throws(() => readFlows(path.join(f, 'bad.json')), /not valid JSON/);
  fs.rmSync(f, { recursive: true, force: true });
});

test('--steps and --allow-writes arguments', () => {
  assert.equal(parseArgs(['--steps', 'f.json']).steps, 'f.json');
  assert.throws(() => parseArgs(['--allow-writes', 'why']), /needs --steps/);
  assert.throws(() => parseArgs(['--steps', 'f.json', '--allow-writes', ' ']), /non-empty reason/);
  assert.equal(parseArgs(['https://a.com']).steps, null, 'plain URL mode is unchanged');
});

test('text targets: xpath literal and deepest-element rule', () => {
  assert.equal(xpathLiteral('Save'), "'Save'");
  assert.equal(xpathLiteral("It's"), '"It\'s"');
  assert.equal(xpathLiteral('a\'b"c'), "concat('a',\"'\",'b\"c')");
  assert.match(textXPath('Go'), /not\(\*\[contains\(normalize-space\(\.\), 'Go'\)\]\)/);
  const r = parseFlows(doc([{ tap: { text: '  Save   now ' } }]), {});
  assert.deepEqual(r.flows[0].steps[0].target, { text: 'Save now' });
});

test('swipe geometry: the finger moves against the scroll direction', () => {
  const rect = { x: 0, y: 100, w: 400, h: 200 };
  const l = swipePoints('left', rect);
  assert.ok(l.from.x > l.to.x && l.from.y === l.to.y);
  const d = swipePoints('down', rect);
  assert.ok(d.from.y < d.to.y && d.from.x === d.to.x);
  for (const p of [l.from, l.to]) assert.ok(p.x >= 0 && p.x <= 400);
});

const step = (o) => ({ i: 1, do: 'tap', label: 'tap #a', ok: true, ms: 10, ...o });
const flow = (o = {}) => ({ name: 'f', start: 'https://a.com/', steps: [step()], probe: { overflowX: false, smallTapTargets: [] }, blocked: [], notes: [], guard: { active: true, how: 'x' }, ms: 1000, ...o });

test('verdict: a failed step, a broken guard or an overflow is an issue', () => {
  assert.deepEqual(flowVerdict(flow()).bad, []);
  assert.ok(flowVerdict(flow({ steps: [step(), step({ i: 2, ok: false, error: 'expectation not met' }), step({ i: 3, ok: false, skipped: true })] })).bad.some((b) => /step 2.*expectation not met/.test(b)));
  assert.ok(flowVerdict(flow({ error: 'boom' })).bad.some((b) => /ERROR boom/.test(b)));
  assert.ok(flowVerdict(flow({ guard: { active: false } })).bad.some((b) => /write guard not active/.test(b)));
  assert.ok(flowVerdict(flow({ guard: { active: true, failed: 1 } })).bad.some((b) => /missing on 1/.test(b)));
  assert.ok(flowVerdict(flow({ probe: { overflowX: true, scrollWidth: 900, innerWidth: 400, wide: ['div'] } })).bad.some((b) => /overflow/.test(b)));
  assert.ok(flowVerdict(flow({ probe: null })).bad.some((b) => /no end-state/.test(b)));
  assert.ok(flowVerdict(flow({ steps: [] })).bad.some((b) => /no step ran/.test(b)));
});

test('verdict: allowed writes are printed, blocked writes are a note', () => {
  const v = flowVerdict(flow({ allowWrites: 'fixture post', guard: { active: false } }));
  assert.deepEqual(v.bad, []);
  assert.ok(v.notes.some((n) => /writes ALLOWED: fixture post/.test(n)));
  const b = flowVerdict(flow({ blocked: ['fetch POST', 'form post'] }));
  assert.deepEqual(b.bad, []);
  assert.ok(b.notes.some((n) => /2 write\(s\) blocked/.test(n)));
});

test('summary and report files', () => {
  const f = flow({ steps: [step({ shot: 'flows/f/01-tap.png', via: 'real touch' }), step({ i: 2, label: 'expect #z visible=true', ok: false, error: 'expectation not met', shot: 'flows/f/02-FAILED-expect.png' })] });
  const md = renderFlowSummary('android', f);
  assert.match(md, /# flow f on android: FAILED/);
  assert.match(md, /\| 2 \| expect #z visible=true \| FAILED: expectation not met/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mqr-'));
  const r = reportFlows({ platform: 'android', flows: [f] }, dir);
  assert.equal(r.issues, 1);
  assert.ok(fs.existsSync(path.join(dir, 'flows', 'f', 'summary.md')));
  assert.ok(r.lines.some((l) => /02-FAILED-expect.png/.test(l)));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(stepLabel({ do: 'type', target: { css: '#q' }, text: 'secret!' }).includes('secret!'), false, 'typed text never lands in a label');
});

// ---- the iOS write guard, run for real in a vm with a page-like global
function pageLike() {
  const sent = [];
  const listeners = [];
  const g = {
    fetch: (u, i) => { sent.push(['fetch', (i && i.method) || 'GET']); return Promise.resolve('sent'); },
    navigator: { sendBeacon: () => { sent.push(['beacon']); return true; } },
    document: { addEventListener: (t, fn, cap) => listeners.push([t, fn, cap]) },
    setTimeout,
    Event: class { constructor(t) { this.type = t; } },
    DOMException: class extends Error { constructor(m, n) { super(m); this.name = n; } },
    HTMLFormElement: function () {},
    XMLHttpRequest: function () {},
    WebSocket: function () { sent.push(['ws']); },
  };
  g.HTMLFormElement.prototype.submit = function () { sent.push(['form.submit', this.method]); };
  g.XMLHttpRequest.prototype.open = function (m) { this.m = m; };
  g.XMLHttpRequest.prototype.send = function () { sent.push(['xhr', this.m]); };
  g.XMLHttpRequest.prototype.dispatchEvent = function (e) { (this.events ||= []).push(e.type); };
  g.window = g;
  return { g, sent, listeners };
}
const runGuard = (g) => JSON.parse(JSON.stringify(vm.runInNewContext('(function(){' + GUARD_SOURCE + '})()', g)));

test('iOS guard: blocks fetch/XHR writes, beacon, form posts and WebSockets; reads pass; idempotent', async () => {
  const { g, sent, listeners } = pageLike();
  assert.deepEqual(runGuard(g), { ok: true, already: false });
  assert.deepEqual(runGuard(g), { ok: true, already: true });
  await assert.rejects(g.window.fetch('/x', { method: 'POST' }), /write guard: POST blocked/);
  await assert.rejects(g.window.fetch('https://other.example/x', { method: 'delete' }), /DELETE blocked/);
  await assert.rejects(g.window.fetch({ method: 'PUT' }), /PUT blocked/);
  assert.equal(await g.window.fetch('/ok'), 'sent');
  assert.equal(await g.window.fetch('/ok', { method: 'get' }), 'sent');
  const x = new g.XMLHttpRequest();
  x.open('POST', '/a'); x.send();
  const y = new g.XMLHttpRequest();
  y.open('GET', '/a'); y.send();
  assert.equal(g.window.navigator.sendBeacon('/b', 'x'), false);
  assert.throws(() => new g.WebSocket('wss://x'), /WebSockets are blocked/);
  const f = new g.HTMLFormElement();
  f.method = 'post'; f.submit();
  f.method = 'get'; f.submit();
  const submit = listeners.find(([t, , cap]) => t === 'submit' && cap === true)[1];
  let prevented = 0;
  submit({ target: { method: 'post' }, submitter: null, preventDefault: () => prevented++, stopImmediatePropagation() {} });
  submit({ target: { method: 'get' }, submitter: null, preventDefault: () => prevented++, stopImmediatePropagation() {} });
  submit({ target: { method: 'get' }, submitter: { formMethod: 'post' }, preventDefault: () => prevented++, stopImmediatePropagation() {} });
  assert.equal(prevented, 2, 'post forms and formmethod=post are stopped, a GET form is not');
  assert.deepEqual(sent.map((s) => s.join(' ')), ['fetch GET', 'fetch get', 'xhr GET', 'form.submit get'], 'nothing but reads reached the network layer');
  assert.ok(g.window.__mqGuard.blocked.length >= 8);
  assert.equal(Object.keys(g.window).includes('__mqGuard'), false, 'the marker is not enumerable');
});

// ---- private mode carries the flows inside the sealed job
const state = { cookies: [{ name: 's', value: 'v'.repeat(20), domain: 'app.example.com', path: '/', expires: Math.floor(Date.now() / 1000) + 7200, httpOnly: true, secure: true, sameSite: 'Lax' }] };
const env = { KITQA_BASE: 'https://app.example.com', KITQA_STORAGE_STATE: 'x' };
const priv = (flows) => JSON.parse(privateFlows(env.KITQA_BASE, flows).wireJson);

test('private: flows need no plain paths, starts are paths on the site, the job re-validates', () => {
  const wire = priv({ flows: [{ name: 'a', start: '/admin#sales', steps: [{ tap: '#x' }, { shot: 'one' }] }] });
  const b = buildJob(env, [], () => state, wire);
  assert.deepEqual(b.job.paths, []);
  assert.deepEqual(b.job.flows.flows[0].start, '/admin#sales');
  const v = validateJob(JSON.parse(JSON.stringify(b.job)));
  assert.deepEqual(v.urls, []);
  assert.throws(() => buildJob(env, [], () => state, null), /no paths/);
  for (const start of ['https://evil.example/', '//evil.example/x', 'admin', '/a b']) {
    assert.throws(() => privateFlows(env.KITQA_BASE, { flows: [{ name: 'a', start, steps: [{ key: 'Tab' }] }] }), /refused|only paths|flow 1/, start);
  }
  const tampered = JSON.parse(JSON.stringify(b.job));
  tampered.flows.flows[0].start = 'https://evil.example/';
  assert.throws(() => validateJob(tampered));
});

test('private: typed text is allowed (it travels sealed) and never printed in the log allow-list', () => {
  assert.doesNotThrow(() => privateFlows(env.KITQA_BASE, { flows: [{ name: 'a', start: '/', steps: [{ type: { selector: '#a', text: 'eyJhbGciOiJIUzI1NiJ9.abcdefghijk' } }] }] }));
  for (const l of ['[flow 1/2]', '  step 3/9', '    step 3/9 ok in 2 s', '    step 3/9 failed in 12 s']) assert.ok(allowedLine(l), l);
  for (const l of ['  step 3/9 tap #secret-token', '[flow 1/2] checkout', '  step 3/9 type into #a (5 characters)']) assert.equal(allowedLine(l), false, l);
});

test('runner loads flows: public needs http(s), private needs paths on the base', () => {
  const pub = loadRunnerFlows({ publicJson: JSON.stringify({ flows: [{ name: 'a', start: 'https://a.com/x', steps: [{ key: 'Tab' }] }], allowWrites: 'why' }) });
  assert.equal(pub.allowWrites, 'why');
  assert.equal(pub.flows[0].start, 'https://a.com/x');
  assert.equal(loadRunnerFlows({ publicJson: '' }), null);
  assert.throws(() => loadRunnerFlows({ publicJson: JSON.stringify({ flows: [{ name: 'a', start: 'file:///x', steps: [{ key: 'Tab' }] }] }) }), /http/);
  const p = loadRunnerFlows({ privateDoc: { flows: [{ name: 'a', start: '/p#x', steps: [{ key: 'Tab' }] }] }, base: 'https://app.example.com' });
  assert.equal(p.flows[0].start, 'https://app.example.com/p#x');
  assert.equal(p.flows[0].startShown, '/p#x');
  assert.throws(() => loadRunnerFlows({ privateDoc: { flows: [{ name: 'a', start: '//evil.example/', steps: [{ key: 'Tab' }] }] }, base: 'https://app.example.com' }), /path on the site/);
  void checkPrivateTarget; void parseStep;
});
