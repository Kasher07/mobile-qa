import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function readUrls() {
  return (process.env.URLS || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));
}

export function maxSegments() {
  const n = Number(process.env.MAX_SEGMENTS || 6);
  return Number.isFinite(n) ? Math.max(1, Math.min(12, Math.round(n))) : 6;
}

export function slug(url, i) {
  const u = new URL(url);
  let p = u.pathname;
  try {
    p = decodeURIComponent(p);
  } catch {}
  p = p.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  const s = (u.hostname + p).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return String(i + 1).padStart(2, '0') + '-' + (s || 'page');
}

export function newPage(url, name) {
  return { url, name, status: null, error: null, probe: null, consoleErrors: [], pageErrors: [], failedRequests: [], shots: [], segmentsNeeded: null };
}

// Screens needed to reach the page bottom when each step scrolls 90% of a screen; capped at max.
export function segmentPlan(scrollHeight, vh, max) {
  const needed = 1 + Math.max(0, Math.ceil((scrollHeight - vh) / (0.9 * vh)));
  return { needed, count: Math.min(max, needed) };
}

// Saved after every page so a hang or a job timeout keeps what was done.
export function saveResults(dir, results) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));
}

// Runs inside the page (Playwright evaluate or WebDriver execute): layout facts a screenshot alone can hide.
export function probe() {
  const de = document.documentElement;
  // Chrome on Android zooms a too-wide page out and widens innerWidth to the content, so compare with the
  // phone's own CSS width (screen) too: the smaller one is what the user really has.
  const screenW = window.screen && screen.width ? Math.min(screen.width, screen.height || screen.width) : window.innerWidth;
  const vw = Math.min(window.innerWidth, screenW);
  const vv = window.visualViewport;
  const nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
  const out = {
    title: document.title,
    innerWidth: vw,
    innerWidthRaw: window.innerWidth,
    href: location.href,
    textLen: document.body ? document.body.innerText.trim().length : 0,
    media: document.querySelectorAll('img,video,canvas,svg,picture,iframe').length,
    screenWidth: screenW,
    scale: vv ? Math.round(vv.scale * 100) / 100 : 1,
    innerHeight: window.innerHeight,
    scrollWidth: de.scrollWidth,
    scrollHeight: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0),
    overflowX: de.scrollWidth > vw + 1,
    wide: [],
    smallTapTargets: [],
    viewportMeta: !!document.querySelector('meta[name=viewport]'),
    navStatus: typeof nav.responseStatus === 'number' ? nav.responseStatus : null,
  };
  const label = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls;
  };
  if (out.overflowX) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > vw + 1) {
        out.wide.push(label(el) + ' right=' + Math.round(r.right));
        if (out.wide.length >= 8) break;
      }
    }
  }
  for (const el of document.querySelectorAll('a[href],button,input,select,textarea,[role=button]')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'inline' || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24)) {
      out.smallTapTargets.push(label(el) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
      if (out.smallTapTargets.length >= 10) break;
    }
  }
  return out;
}

export function writeResults(dir, results) {
  for (const p of results.pages) p.mode = results.mode;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(results, null, 2));
  console.log(results.platform + ' | ' + results.device + ' | ' + results.browser + ' | mode=' + (results.mode || '-'));
  for (const p of results.pages) {
    const pr = p.probe || {};
    console.log('- ' + p.url + ' :: ' + (p.error ? 'ERROR ' + p.error : 'ok') + ' overflowX=' + !!pr.overflowX + ' shots=' + p.shots.length);
  }
}
