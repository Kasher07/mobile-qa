// Flow steps on Chrome for Android (Playwright's Android API). Taps and swipes are real touches: Android's own input system
// (adb input, the same path a finger takes), so Chrome shows the soft keyboard and the browser bars react. Because adb works in
// screen pixels, the page-to-screen offset is measured before each touch with a transparent overlay that swallows one tap
// (the page never receives it). Text is typed with DevTools key events after a real tap focused the field (not through the
// keyboard app). Back is the hardware Back key. Forward has no hardware key: DevTools history. Scroll to/by is a script scroll.
import fs from 'node:fs';
import path from 'node:path';
import { probe, withTimeout } from './lib.mjs';
import { LIMITS, textXPath, stepLabel, swipePoints, fileSafe } from './flows.mjs';

const loc = (page, t) => (t.css !== undefined ? page.locator('css=' + t.css) : page.locator('xpath=' + textXPath(t.text)));
const firstVisible = (page, t) => loc(page, t).filter({ visible: true }).first();
const wait = (page, ms) => page.waitForTimeout(ms);

async function until(fn, timeoutMs, page, everyMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => false);
    if (v) return true;
    if (Date.now() >= end) return false;
    await wait(page, everyMs);
  }
}

const KEYBOARD_CMD = "dumpsys input_method | grep -m1 -o 'mInputShown=[a-z]*'";
export async function keyboardUp(sh) {
  return /mInputShown=true/.test(await sh(KEYBOARD_CMD).catch(() => ''));
}

// Screen pixels of the page origin: tap the centre of the screen once, under a transparent overlay that eats the tap, and
// compare where the page saw it (CSS px) with where adb sent it (screen px).
async function calibrate(env) {
  const { page, device, sh } = env;
  const m = /(\d+)x(\d+)/.exec(await sh('wm size | tail -1'));
  if (!m) throw new Error('screen size unknown');
  const sw = Number(m[1]);
  const sh_ = Number(m[2]);
  const p = page.evaluate(
    () =>
      new Promise((resolve) => {
        const d = document.createElement('div');
        d.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:transparent;touch-action:none';
        const done = (v) => {
          clearTimeout(timer);
          setTimeout(() => d.remove(), 150);
          resolve(v);
        };
        const timer = setTimeout(() => done(null), 4000);
        const eat = (e) => {
          e.preventDefault();
          e.stopPropagation();
        };
        d.addEventListener('pointerdown', (e) => done({ cx: e.clientX, cy: e.clientY, dpr: window.devicePixelRatio }), true);
        for (const t of ['pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup']) d.addEventListener(t, eat, true);
        document.documentElement.appendChild(d);
      }),
  );
  await wait(page, 100);
  await device.input.tap({ x: Math.round(sw / 2), y: Math.round(sh_ / 2) });
  const r = await p;
  await wait(page, 250);
  if (!r) throw new Error('calibration tap not seen by the page');
  return { ox: sw / 2 - r.cx * r.dpr, oy: sh_ / 2 - r.cy * r.dpr, dpr: r.dpr, sw, sh: sh_ };
}
async function cal(env) {
  if (!env.cal) env.cal = await calibrate(env);
  return env.cal;
}
const toScreen = (c, x, y) => ({ x: Math.round(c.ox + x * c.dpr), y: Math.round(c.oy + y * c.dpr) });

// The visible part of the element, and whether something else sits over its centre.
async function aim(l) {
  await l.scrollIntoViewIfNeeded({ timeout: 5000 });
  return l.evaluate((el) => {
    const vv = window.visualViewport;
    const top0 = vv ? vv.offsetTop : 0;
    const left0 = vv ? vv.offsetLeft : 0;
    const w = vv ? vv.width : innerWidth;
    const h = vv ? vv.height : innerHeight;
    const r = el.getBoundingClientRect();
    const x0 = Math.max(r.left, left0);
    const x1 = Math.min(r.right, left0 + w);
    const y0 = Math.max(r.top, top0);
    const y1 = Math.min(r.bottom, top0 + h);
    if (x1 - x0 < 1 || y1 - y0 < 1) return { error: 'the element is outside the visible screen (covered by the keyboard or off screen)' };
    const x = (x0 + x1) / 2;
    const y = (y0 + y1) / 2;
    const hit = document.elementFromPoint(x, y);
    const label = (n) => n.tagName.toLowerCase() + (n.id ? '#' + n.id : '');
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) return { x, y, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, error: 'another element covers the tap point: ' + label(hit) };
    return { x, y, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  });
}

async function realTap(env, l) {
  const a = await aim(l);
  if (a.error) throw new Error(a.error);
  try {
    const c = await cal(env);
    await env.device.input.tap(toScreen(c, a.x, a.y));
    return 'real touch (adb input tap)';
  } catch (e) {
    env.cal = null;
    try {
      await env.page.touchscreen.tap(a.x, a.y);
      return 'DevTools touch (adb tap unavailable: ' + String(e.message).split('\n')[0].slice(0, 60) + ')';
    } catch {
      await l.click({ timeout: 5000 });
      return 'synthesized click (no touch available)';
    }
  }
}

const KEYMAP = { Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Escape: 'Escape' };

async function doStep(env, s) {
  const { page, device, sh } = env;
  const to = (t) => firstVisible(page, t);
  switch (s.do) {
    case 'tap': {
      const l = to(s.target);
      await l.waitFor({ state: 'visible', timeout: 10000 });
      const via = await realTap(env, l);
      env.cal = null;
      await wait(page, 500);
      return { via };
    }
    case 'type': {
      const l = to(s.target);
      await l.waitFor({ state: 'visible', timeout: 10000 });
      let via = await realTap(env, l);
      env.cal = null;
      await wait(page, 700);
      const focused = await l.evaluate((el) => document.activeElement === el);
      if (!focused) {
        await l.focus({ timeout: 3000 });
        via += ', focus set by script (the tap did not focus it)';
      }
      if (s.clear) {
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Backspace');
      }
      await page.keyboard.type(s.text, { delay: 25 });
      return { via: via + '; text sent as DevTools key events', kb: await keyboardUp(sh) };
    }
    case 'key':
      await page.keyboard.press(KEYMAP[s.key]);
      await wait(page, 400);
      return { via: 'DevTools key event' };
    case 'back': {
      const kb = await keyboardUp(sh);
      await device.input.press('Back');
      env.cal = null;
      await wait(page, 900);
      return { via: 'hardware Back key' + (kb ? ' (the keyboard was up: Back closed it first, the page did not go back)' : '') };
    }
    case 'forward':
      await page.goForward({ timeout: 10000, waitUntil: 'load' });
      env.cal = null;
      return { via: 'DevTools history (Android has no Forward key)' };
    case 'scroll':
      if (s.target) await to(s.target).scrollIntoViewIfNeeded({ timeout: 10000 });
      else await page.evaluate((y) => window.scrollBy(0, y), s.by);
      env.cal = null;
      await wait(page, 400);
      return { via: 'script scroll' };
    case 'swipe': {
      let from;
      let toPt;
      if (s.direction) {
        let rect;
        if (s.target) {
          const l = to(s.target);
          await l.waitFor({ state: 'visible', timeout: 10000 });
          const a = await aim(l);
          if (a.error && !a.rect) throw new Error(a.error);
          rect = a.rect;
        } else {
          rect = await page.evaluate(() => ({ x: 0, y: 0, w: innerWidth, h: innerHeight }));
        }
        ({ from, to: toPt } = swipePoints(s.direction, rect));
      } else {
        const vp = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
        from = { x: Math.round(s.from[0] * vp.w), y: Math.round(s.from[1] * vp.h) };
        toPt = { x: Math.round(s.to[0] * vp.w), y: Math.round(s.to[1] * vp.h) };
      }
      const c = await cal(env);
      await device.input.swipe(toScreen(c, from.x, from.y), [toScreen(c, toPt.x, toPt.y)], 20);
      env.cal = null;
      await wait(page, 700);
      return { via: 'real touch (adb input swipe)' };
    }
    case 'wait': {
      if (s.ms !== undefined) {
        await wait(page, s.ms);
        return { via: 'timer' };
      }
      const ok = await until(
        async () => {
          const n = await loc(page, s.target).filter({ visible: true }).count();
          return s.state === 'visible' ? n > 0 : n === 0;
        },
        s.timeout,
        page,
      );
      if (!ok) throw new Error('still ' + (s.state === 'visible' ? 'not visible' : 'visible') + ' after ' + s.timeout + ' ms');
      return { via: 'poll' };
    }
    case 'expect': {
      const check = async () => {
        if (s.count !== undefined) return (await loc(page, s.target).count()) === s.count;
        if (s.inViewport !== undefined) {
          const l = loc(page, s.target).first();
          if (!(await l.count())) return false;
          const inside = await l.evaluate((el) => {
            const vv = window.visualViewport;
            const t0 = vv ? vv.offsetTop : 0;
            const l0 = vv ? vv.offsetLeft : 0;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= t0 - 0.5 && r.left >= l0 - 0.5 && r.bottom <= t0 + (vv ? vv.height : innerHeight) + 0.5 && r.right <= l0 + (vv ? vv.width : innerWidth) + 0.5;
          });
          return inside === s.inViewport;
        }
        return ((await loc(page, s.target).filter({ visible: true }).count()) > 0) === s.visible;
      };
      if (!(await until(check, 2000, page))) {
        const n = await loc(page, s.target).count().catch(() => '?');
        throw new Error('expectation not met (' + n + ' match(es) in the page)');
      }
      return { via: 'poll up to 2 s' };
    }
    case 'shot':
      return { via: 'device screenshot' };
    default:
      throw new Error('unknown step');
  }
}

// env: { device, sh, page, outDir, ensureTop, blocked (array shared with the context route), allowWrites, guardOk, deadline }
export async function runFlowAndroid(env, flow, { log = () => {}, startedAt = Date.now(), showLabels = true } = {}) {
  const dir = path.join(env.outDir, 'flows', flow.name);
  fs.mkdirSync(dir, { recursive: true });
  const res = { name: flow.name, start: flow.startShown || flow.start, steps: [], blocked: [], notes: [], probe: null, shots: [], guard: { active: !!env.guardActive, how: env.allowWrites ? 'off (writes allowed)' : 'context route: every non-GET/HEAD/OPTIONS request to any origin is aborted; service workers blocked; WebSockets closed' }, allowWrites: env.allowWrites || null, ms: 0 };
  const blockedBefore = env.blocked.length;
  const t0 = Date.now();
  const snap = async (stem) => {
    await env.ensureTop({});
    const f = fileSafe(stem) + '.png';
    fs.writeFileSync(path.join(dir, f), await withTimeout(env.device.screenshot(), 30000, 'screenshot'));
    res.shots.push(f);
    return 'flows/' + flow.name + '/' + f;
  };
  let failed = false;
  for (const [k, s] of flow.steps.entries()) {
    const i = k + 1;
    const label = stepLabel(s);
    const rec = { i, do: s.do, label, ok: false, ms: 0 };
    res.steps.push(rec);
    if (failed) { rec.skipped = true; continue; }
    if (Date.now() - t0 > LIMITS.flowMs) {
      rec.error = 'the flow time limit (' + LIMITS.flowMs / 1000 + ' s) was used up';
      failed = true;
      continue;
    }
    const st = Date.now();
    log('  step ' + i + '/' + flow.steps.length + (showLabels ? ' ' + label : ''));
    try {
      const out = await withTimeout(doStep(env, s), LIMITS.stepMs, 'step');
      rec.via = out.via;
      if (out.kb !== undefined) rec.kb = out.kb;
      rec.ok = true;
      if (rec.kb === undefined) rec.kb = await keyboardUp(env.sh);
    } catch (e) {
      rec.error = String((e && e.message) || e).split('\n')[0].slice(0, 300);
      failed = true;
    }
    rec.ms = Date.now() - st;
    try {
      rec.shot = await withTimeout(snap(String(i).padStart(2, '0') + '-' + (rec.ok ? (s.do === 'shot' ? 'shot-' + s.name : s.do) : 'FAILED-' + s.do)), 35000, 'screenshot');
    } catch (e) {
      rec.error = (rec.error ? rec.error + '; ' : '') + 'screenshot failed: ' + String(e.message).slice(0, 80);
      if (rec.ok) { rec.ok = false; failed = true; }
    }
    log('    step ' + i + '/' + flow.steps.length + ' ' + (rec.ok ? 'ok' : 'failed') + ' in ' + Math.round(rec.ms / 1000) + ' s');
  }
  try {
    res.probe = await withTimeout(env.page.evaluate(probe), 15000, 'probe');
  } catch (e) {
    res.notes.push('end-state probe failed: ' + String(e.message).split('\n')[0].slice(0, 100));
  }
  res.blocked = env.blocked.slice(blockedBefore);
  res.ms = Date.now() - t0;
  res.status = failed ? 'failed' : 'passed';
  void startedAt;
  return res;
}
