// Flow steps on Safari in the iOS Simulator, driven by safaridriver (WebDriver). What is and is not a finger: element click, sendKeys
// and key actions are WebDriver commands that Safari turns into events (a synthesized click, not a touch on the glass); swipe uses
// W3C pointer actions of type touch when this Safari accepts them and otherwise falls back to a script scroll, which the step result
// says in plain words. Back and Forward are WebDriver history commands. Pinch and multi-finger gestures are not available.
// safaridriver has no run-at-document-start hook, so the write guard (flows.mjs GUARD_SOURCE) is injected as soon as each new
// document has loaded and checked before every step: requests the page itself sends while it loads are not covered.
import fs from 'node:fs';
import path from 'node:path';
import { probe, withTimeout } from './lib.mjs';
import { LIMITS, textXPath, stepLabel, swipePoints, fileSafe, GUARD_SOURCE, GUARD_CHECK, GUARD_READ } from './flows.mjs';

const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const KEYS = { Enter: '', Tab: '', Backspace: '', Escape: '' };
const ref = (id) => ({ [ELEMENT_KEY]: id });
const idOf = (e) => e[ELEMENT_KEY] || Object.values(e)[0];

export async function runFlowIos(env, flow, { log = () => {}, showLabels = true } = {}) {
  const { wd, sid, exec, sleep } = env;
  const dir = path.join(env.outDir, 'flows', flow.name);
  fs.mkdirSync(dir, { recursive: true });
  const res = {
    name: flow.name,
    start: flow.startShown || flow.start,
    steps: [],
    blocked: [],
    notes: [],
    probe: null,
    shots: [],
    guard: { active: false, how: env.allowWrites ? 'off (writes allowed)' : 'JavaScript guard injected after each document loads (fetch/XHR writes, sendBeacon, non-GET forms, WebSockets); safaridriver cannot inject at document start', documents: 0, late: 0, failed: 0 },
    allowWrites: env.allowWrites || null,
    ms: 0,
  };
  const t0 = Date.now();
  const elements = async (t) => {
    const r = await wd('POST', '/session/' + sid + '/elements', t.css !== undefined ? { using: 'css selector', value: t.css } : { using: 'xpath', value: textXPath(t.text) });
    return (r || []).map(idOf);
  };
  // safaridriver has no "is displayed" endpoint: ask the page (a non-empty box that is not hidden, like Playwright's visible).
  const VISIBLE_JS = 'var el=arguments[0]; var r=el.getBoundingClientRect(); if(!(r.width>0&&r.height>0)) return false; var cs=getComputedStyle(el); return cs.visibility!=="hidden"&&cs.display!=="none"&&parseFloat(cs.opacity)>0;';
  const isShown = (id) => exec(VISIBLE_JS, [ref(id)]).catch(() => false);
  const visibleOnes = async (t) => {
    const out = [];
    for (const id of (await elements(t)).slice(0, 40)) if (await isShown(id)) out.push(id);
    return out;
  };
  const until = async (fn, ms, every = 300) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await fn().catch(() => false)) return true;
      if (Date.now() >= end) return false;
      await sleep(every);
    }
  };
  const firstVisible = async (t, ms = 10000) => {
    let got = null;
    if (!(await until(async () => (got = (await visibleOnes(t))[0]) !== undefined, ms))) throw new Error('not visible after ' + ms / 1000 + ' s: ' + (t.css ?? '"' + t.text + '"'));
    return got;
  };

  // Guard: checked before every step (a new document has none), injected when missing, read after the step.
  let seen = 0;
  const ensureGuard = async () => {
    if (env.allowWrites) return;
    let has = false;
    try {
      has = await exec(GUARD_CHECK);
    } catch (e) {
      res.guard.failed++;
      throw new Error('write guard could not be checked: ' + String(e.message).slice(0, 80));
    }
    if (has) { res.guard.active = true; return; }
    try {
      const r = await exec(GUARD_SOURCE);
      if (!r || !r.ok || !(await exec(GUARD_CHECK))) throw new Error('guard did not take');
    } catch (e) {
      res.guard.failed++;
      throw new Error('write guard could not be installed: ' + String(e.message).slice(0, 80));
    }
    res.guard.documents++;
    res.guard.late++;
    res.guard.active = true;
    seen = 0;
  };
  const readBlocked = async () => {
    if (env.allowWrites) return;
    const b = await exec(GUARD_READ).catch(() => null);
    if (Array.isArray(b) && b.length > seen) {
      res.blocked.push(...b.slice(seen));
      seen = b.length;
    }
  };

  // A WebDriver click is only trusted once the page saw a click on the element: armed before, read after.
  const TAP_ARM = 'var el=arguments[0]; el.scrollIntoView({block:"center",inline:"nearest"}); var st={hit:null}; window.__mqTap=st; var h=function(e){ if(!st.hit){ var t=e.target; st.hit={x:Math.round(e.clientX),y:Math.round(e.clientY),on:(t===el||el.contains(t)),what:(t.tagName||"").toLowerCase()+(t.id?"#"+t.id:"")}; } }; st.off=function(){document.removeEventListener("click",h,true);}; document.addEventListener("click",h,true); var r=el.getBoundingClientRect(); st.c={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}; return true;';
  const TAP_READ = 'var st=window.__mqTap; if(!st) return null; st.off(); return {hit:st.hit,c:st.c};';
  const CLICK_VIA = 'WebDriver element click (synthesized click, not a finger)';
  async function clickChecked(id) {
    await exec(TAP_ARM, [ref(id)]);
    await wd('POST', '/session/' + sid + '/element/' + id + '/click', {});
    await sleep(600);
    const r = await exec(TAP_READ).catch(() => null); // null: the page navigated away, which a click on a link does
    if (r && !r.hit) {
      await exec('arguments[0].click(); return true;', [ref(id)]);
      return 'script click (WebDriver click sent the page no click event: NOT a finger)';
    }
    if (r && r.hit && !r.hit.on) throw new Error('the WebDriver click landed on ' + r.hit.what + ' at (' + r.hit.x + ',' + r.hit.y + ') instead of the element (centre ' + r.c.x + ',' + r.c.y + ')');
    return CLICK_VIA;
  }
  const valueOf = (id) => exec('var el=arguments[0]; return el.value===undefined?null:String(el.value);', [ref(id)]);
  const SCROLL_STATE = 'var el=arguments[0]||document.documentElement; var s=[window.scrollX,window.scrollY]; for(var n=el;n&&n!==document.documentElement;n=n.parentElement){s.push(n.scrollLeft,n.scrollTop);} return s.join(",");';

  const viewport = () => exec('return {w: window.innerWidth, h: window.innerHeight};');
  const rectOf = (id) =>
    exec(
      'var el=arguments[0]; el.scrollIntoView({block:"center",inline:"nearest"}); var r=el.getBoundingClientRect(); var w=window.innerWidth,h=window.innerHeight; var x0=Math.max(r.left,0),x1=Math.min(r.right,w),y0=Math.max(r.top,0),y1=Math.min(r.bottom,h); return {x:x0,y:y0,w:Math.max(0,x1-x0),h:Math.max(0,y1-y0)};',
      [ref(id)],
    );

  async function doStep(s) {
    switch (s.do) {
      case 'tap': {
        const id = await firstVisible(s.target);
        return { via: await clickChecked(id) };
      }
      case 'type': {
        const id = await firstVisible(s.target);
        let via = await clickChecked(id);
        await sleep(400);
        if (s.clear) await wd('POST', '/session/' + sid + '/element/' + id + '/clear', {});
        const base = s.clear ? '' : await valueOf(id);
        const want = base === null ? null : base + s.text;
        // Typing is verified (Safari's sendKeys has ignored text in this simulator): sendKeys, then key actions, then script.
        await wd('POST', '/session/' + sid + '/element/' + id + '/value', { text: s.text }).catch(() => {});
        await sleep(400);
        if (want === null || (await valueOf(id)) === want) return { via: via + '; WebDriver sendKeys (synthesized; the on-screen keyboard shows only if Safari raises it)' };
        await exec('arguments[0].value = arguments[1]; return true;', [ref(id), base]);
        await wd('POST', '/session/' + sid + '/actions', { actions: [{ type: 'key', id: 'kb', actions: [...s.text].flatMap((ch) => [{ type: 'keyDown', value: ch }, { type: 'keyUp', value: ch }]) }] }).catch(() => {});
        await wd('DELETE', '/session/' + sid + '/actions').catch(() => {});
        await sleep(400);
        if ((await valueOf(id)) === want) return { via: via + '; WebDriver key actions (sendKeys put no text in the field)' };
        await exec('var el=arguments[0]; el.focus(); el.value=arguments[1]; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); return true;', [ref(id), want]);
        res.notes.push('type: sendKeys and key actions put no text in the field; the text was set by script (input/change events), NOT typed');
        return { via: via + '; script value + input events (sendKeys and key actions typed nothing: NOT typed)' };
      }
      case 'key': {
        try {
          await wd('POST', '/session/' + sid + '/actions', { actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: KEYS[s.key] }, { type: 'keyUp', value: KEYS[s.key] }] }] });
          await wd('DELETE', '/session/' + sid + '/actions').catch(() => {});
          await sleep(500);
          return { via: 'WebDriver key action' };
        } catch (e) {
          const a = await wd('GET', '/session/' + sid + '/element/active');
          await wd('POST', '/session/' + sid + '/element/' + idOf(a) + '/value', { text: KEYS[s.key] });
          await sleep(500);
          return { via: 'WebDriver sendKeys to the focused element (key actions failed: ' + String(e.message).slice(0, 50) + ')' };
        }
      }
      case 'back':
        await wd('POST', '/session/' + sid + '/back', {});
        await sleep(1200);
        return { via: 'WebDriver history back' };
      case 'forward':
        await wd('POST', '/session/' + sid + '/forward', {});
        await sleep(1200);
        return { via: 'WebDriver history forward' };
      case 'scroll':
        if (s.target) await exec('arguments[0].scrollIntoView({block:"center",inline:"nearest"}); return true;', [ref(await firstVisible(s.target))]);
        else await exec('window.scrollBy(0, arguments[0]); return true;', [s.by]);
        await sleep(500);
        return { via: 'script scroll' };
      case 'swipe': {
        let from;
        let to;
        let rect = null;
        let id = null;
        if (s.direction) {
          if (s.target) {
            id = await firstVisible(s.target);
            rect = await rectOf(id);
          } else {
            const vp = await viewport();
            rect = { x: 0, y: 0, w: vp.w, h: vp.h };
          }
          ({ from, to } = swipePoints(s.direction, rect));
        } else {
          const vp = await viewport();
          from = { x: Math.round(s.from[0] * vp.w), y: Math.round(s.from[1] * vp.h) };
          to = { x: Math.round(s.to[0] * vp.w), y: Math.round(s.to[1] * vp.h) };
        }
        const before = await exec(SCROLL_STATE, [id ? ref(id) : null]).catch(() => '');
        try {
          await wd('POST', '/session/' + sid + '/actions', {
            actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
              { type: 'pointerMove', duration: 0, x: from.x, y: from.y, origin: 'viewport' },
              { type: 'pointerDown', button: 0 },
              { type: 'pause', duration: 80 },
              { type: 'pointerMove', duration: 450, x: to.x, y: to.y, origin: 'viewport' },
              { type: 'pointerUp', button: 0 },
            ] }],
          });
          await wd('DELETE', '/session/' + sid + '/actions').catch(() => {});
          await sleep(900);
          if ((await exec(SCROLL_STATE, [id ? ref(id) : null]).catch(() => '')) === before) throw new Error('accepted but nothing scrolled');
          return { via: 'W3C touch pointer actions (WebDriver synthesized touch, not the simulator glass)' };
        } catch (e) {
          // This Safari did not take touch pointer actions: scroll the element (or the page) by script instead, and say so.
          const dx = to.x - from.x;
          const dy = to.y - from.y;
          await exec('var el = arguments[0] ? arguments[0] : (document.scrollingElement || document.documentElement); el.scrollBy({left: -arguments[1], top: -arguments[2], behavior: "instant"}); return true;', [id ? ref(id) : null, dx, dy]);
          await sleep(700);
          res.notes.push('swipe: touch pointer actions had no effect or were refused (' + String(e.message).split('\n')[0].slice(0, 80) + '); done as a script scroll, NOT a finger swipe');
          return { via: 'script scroll fallback (touch actions had no effect: NOT a finger swipe)' };
        }
      }
      case 'wait': {
        if (s.ms !== undefined) {
          await sleep(s.ms);
          return { via: 'timer' };
        }
        const ok = await until(async () => {
          const n = (await visibleOnes(s.target)).length;
          return s.state === 'visible' ? n > 0 : n === 0;
        }, s.timeout);
        if (!ok) throw new Error('still ' + (s.state === 'visible' ? 'not visible' : 'visible') + ' after ' + s.timeout + ' ms');
        return { via: 'poll' };
      }
      case 'expect': {
        const check = async () => {
          if (s.count !== undefined) return (await elements(s.target)).length === s.count;
          if (s.inViewport !== undefined) {
            const first = (await elements(s.target))[0];
            if (first === undefined) return false;
            const inside = await exec(
              'var el=arguments[0]; var vv=window.visualViewport; var t0=vv?vv.offsetTop:0, l0=vv?vv.offsetLeft:0; var r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&r.top>=t0-0.5&&r.left>=l0-0.5&&r.bottom<=t0+(vv?vv.height:window.innerHeight)+0.5&&r.right<=l0+(vv?vv.width:window.innerWidth)+0.5;',
              [ref(first)],
            );
            return inside === s.inViewport;
          }
          return ((await visibleOnes(s.target)).length > 0) === s.visible;
        };
        if (!(await until(check, 2000))) throw new Error('expectation not met (' + (await elements(s.target).then((a) => a.length).catch(() => '?')) + ' match(es) in the page)');
        return { via: 'poll up to 2 s' };
      }
      case 'shot':
        return { via: 'simulator screenshot' };
      default:
        throw new Error('unknown step');
    }
  }

  let failed = false;
  try {
    await ensureGuard();
  } catch (e) {
    res.error = 'the flow did not run: ' + e.message;
    failed = true;
  }
  for (const [k, s] of flow.steps.entries()) {
    const i = k + 1;
    const rec = { i, do: s.do, label: stepLabel(s), ok: false, ms: 0 };
    res.steps.push(rec);
    if (failed) { rec.skipped = true; continue; }
    if (Date.now() - t0 > LIMITS.flowMs) {
      rec.error = 'the flow time limit (' + LIMITS.flowMs / 1000 + ' s) was used up';
      failed = true;
      continue;
    }
    const st = Date.now();
    log('  step ' + i + '/' + flow.steps.length + (showLabels ? ' ' + rec.label : ''));
    try {
      await ensureGuard();
      const out = await withTimeout(doStep(s), LIMITS.stepMs, 'step');
      rec.via = out.via;
      rec.ok = true;
      await readBlocked();
    } catch (e) {
      rec.error = String((e && e.message) || e).split('\n')[0].slice(0, 300);
      failed = true;
      await readBlocked().catch(() => {});
    }
    rec.ms = Date.now() - st;
    try {
      const f = fileSafe(String(i).padStart(2, '0') + '-' + (rec.ok ? (s.do === 'shot' ? 'shot-' + s.name : s.do) : 'FAILED-' + s.do)) + '.jpg';
      rec.shot = 'flows/' + flow.name + '/' + env.shot('flows/' + flow.name + '/' + f).split('/').pop();
      res.shots.push(f);
    } catch (e) {
      rec.error = (rec.error ? rec.error + '; ' : '') + 'screenshot failed: ' + String(e.message).slice(0, 80);
      if (rec.ok) { rec.ok = false; failed = true; }
    }
    log('    step ' + i + '/' + flow.steps.length + ' ' + (rec.ok ? 'ok' : 'failed') + ' in ' + Math.round(rec.ms / 1000) + ' s');
  }
  try {
    res.probe = await exec('return (' + probe.toString() + ')();');
  } catch (e) {
    res.notes.push('end-state probe failed: ' + String(e.message).split('\n')[0].slice(0, 100));
  }
  await readBlocked().catch(() => {});
  res.ms = Date.now() - t0;
  res.status = failed ? 'failed' : 'passed';
  return res;
}
