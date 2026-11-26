import test from 'node:test';
import assert from 'node:assert/strict';
import { iosInfraSummaryLine, verdict } from '../bin/mobile-qa.mjs';

const probe = (o = {}) => Object.assign({ title: 'x', innerWidth: 412, innerWidthRaw: 412, screenWidth: 412, scale: 1, scrollWidth: 412, scrollHeight: 900,
  overflowX: false, wide: [], smallTapTargets: [], viewportMeta: true, navStatus: 200, href: 'https://a.com/p', textLen: 500, media: 2 }, o);
const pg = (o = {}) => Object.assign({ url: 'https://a.com/p', status: 200, error: null, probe: probe(), consoleErrors: [], pageErrors: [], failedRequests: [], shots: ['a.png'], segmentsNeeded: 1 }, o);
const isOk = (p) => assert.deepEqual(verdict(p).bad, []);
const isBad = (p, re) => assert.ok(verdict(p).bad.some((b) => re.test(b)), JSON.stringify(verdict(p)));

test('clean page is ok', () => isOk(pg()));
test('iOS infrastructure summary markers expose only supported stages', () => {
  assert.equal(iosInfraSummaryLine({ platform: 'ios', iosInfraStage: 'boot' }), 'mobile-qa: ios-infra stage=boot');
  assert.equal(iosInfraSummaryLine({ platform: 'ios', iosInfraStage: 'safari-launch' }), 'mobile-qa: ios-infra stage=safari-launch');
  assert.equal(iosInfraSummaryLine({ platform: 'ios', iosInfraStage: 'webdriver-session' }), 'mobile-qa: ios-infra stage=webdriver-session');
  assert.equal(iosInfraSummaryLine({ platform: 'android', iosInfraStage: 'boot' }), null);
  assert.equal(iosInfraSummaryLine({ platform: 'ios', iosInfraStage: 'other' }), null);
});
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
test('bot challenge is reported as blocked, not as a page bug', () => {
  const v = verdict(pg({ status: 403, probe: probe({ challenge: 'Cloudflare', textLen: 274 }) }));
  assert.ok(v.bad.some((b) => /blocked by Cloudflare/.test(b)));
  assert.ok(!v.bad.some((b) => /^HTTP/.test(b)));
});
test('403 from the runner fetch on a real page is a note', () => {
  const v = verdict(pg({ status: 403, statusSource: 'server request from the runner' }));
  assert.deepEqual(v.bad, []);
  assert.ok(v.notes.some((n) => /non-browser/.test(n)));
});
test('403 from the browser itself stays an issue', () => isBad(pg({ status: 403 }), /HTTP 403/));
test('a page that passed on a retry is ok with a note', () => {
  const v = verdict(pg({ retried: 'page did not finish in 150 s' }));
  assert.deepEqual(v.bad, []);
  assert.ok(v.notes.some((n) => /second try/.test(n)));
});
test('truncated screens are noted', () => assert.ok(verdict(pg({ segmentsNeeded: 8 })).notes.some((n) => /1\/8/.test(n))));
