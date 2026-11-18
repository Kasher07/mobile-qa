import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict } from '../bin/mobile-qa.mjs';

const probe = (o = {}) => Object.assign({ title: 'x', innerWidth: 412, innerWidthRaw: 412, screenWidth: 412, scale: 1, scrollWidth: 412, scrollHeight: 900,
  overflowX: false, wide: [], smallTapTargets: [], viewportMeta: true, navStatus: 200, href: 'https://a.com/p', textLen: 500, media: 2 }, o);
const pg = (o = {}) => Object.assign({ url: 'https://a.com/p', status: 200, error: null, probe: probe(), consoleErrors: [], pageErrors: [], failedRequests: [], shots: ['a.png'], segmentsNeeded: 1 }, o);
const isOk = (p) => assert.deepEqual(verdict(p).bad, []);
const isBad = (p, re) => assert.ok(verdict(p).bad.some((b) => re.test(b)), JSON.stringify(verdict(p)));

test('clean page is ok', () => isOk(pg()));
test('no probe without error is never ok (iOS openurl fallback)', () => isBad(pg({ probe: null, status: null, mode: 'openurl' }), /not checked/));
test('HTTP errors', () => isBad(pg({ status: 503 }), /HTTP 503/));
test('status 0 / null does not hide other checks', () => isOk(pg({ status: 0 })));
test('redirect to another host is an issue', () => isBad(pg({ probe: probe({ href: 'https://parking.example/' }) }), /another host/));
test('www difference is not a redirect issue', () => isOk(pg({ probe: probe({ href: 'https://www.a.com/p' }) })));
test('redirect to another path is a note', () => {
  const v = verdict(pg({ probe: probe({ href: 'https://a.com/login' }) }));
  assert.deepEqual(v.bad, []);
  assert.ok(v.notes.some((n) => /redirected to \/login/.test(n)));
});
test('browser error page', () => isBad(pg({ probe: probe({ href: 'about:blank' }) }), /browser error page/));
test('overflow', () => isBad(pg({ probe: probe({ overflowX: true, scrollWidth: 656 }) }), /overflow/));
test('zoomed out page', () => {
  isBad(pg({ probe: probe({ scale: 0.6 }) }), /wider than the screen/);
  isBad(pg({ probe: probe({ innerWidthRaw: 700 }) }), /wider than the screen/);
});
test('missing viewport', () => isBad(pg({ probe: probe({ viewportMeta: false }) }), /viewport/));
test('blank page', () => {
  isBad(pg({ probe: probe({ textLen: 0, media: 0 }) }), /blank/);
  isOk(pg({ probe: probe({ textLen: 0, media: 3 }) }));
});
test('JS errors and missing screenshots', () => {
  isBad(pg({ pageErrors: ['boom'] }), /JS errors/);
  isBad(pg({ shots: [] }), /no screenshot/);
});
test('system window over the page', () => isBad(pg({ overlay: 'Application Not Responding: launcher' }), /system window/));
test('truncated screens are noted', () => assert.ok(verdict(pg({ segmentsNeeded: 8 })).notes.some((n) => /1\/8/.test(n))));
