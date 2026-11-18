import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUrl, parseArgs } from '../bin/mobile-qa.mjs';
import { segmentPlan, slug, readUrls, maxSegments } from '../runner/lib.mjs';

const ok = (u) => assert.ok(checkUrl(u).href, u + ' should pass: ' + JSON.stringify(checkUrl(u)));
const no = (u) => assert.ok(checkUrl(u).why, u + ' should be refused');

test('checkUrl accepts public pages', () => {
  ok('https://kittran.vercel.app');
  ok('https://kittran.vercel.app/en/blog/kit-truoc-va-sau-mot-lan-refactor-toan-he-thong');
  ok('https://a.com/?design=1&keyword=x&page=2');
  ok('https://a.com/tiếng-việt.html');
  ok('http://example.com/a b');
  ok('https://sub.domain.co.uk/path?utm_source=x');
});

test('checkUrl refuses unreachable or private hosts', () => {
  for (const u of ['http://localhost:3000', 'http://localhost.', 'http://foo.localhost/', 'http://x.local./', 'http://box.internal/',
    'http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.20.0.1/', 'http://169.254.1.1/', 'http://100.64.1.1/',
    'http://0x7f000001/', 'http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/', 'http://myserver/',
    'ftp://a.com/', 'file:///c:/x.html', 'not a url']) no(u);
});

test('checkUrl refuses secrets (public repo)', () => {
  for (const u of ['https://u:p@a.com/', 'https://a.com/?token=1', 'https://a.com/?access_token=1', 'https://a.com/?api-key=1',
    'https://a.com/?X-Amz-Credential=1', 'https://a.com/?pwd=1', 'https://a.com/?session_id=1', 'https://a.com/?id=eyJhbGciOiJIUzI1NiJ9.abc',
    'https://a.com/?r=a8f9c2d7e6b5a4f3c2d1e0f9', 'https://a.com/reset/a8f9c2d7e6b5a4f3c2d1e0f9', 'https://a.com/#access_token=x',
    'https://a.com/a,b']) no(u);
});

test('checkUrl normalises what it sends', () => {
  assert.equal(checkUrl('HTTPS://A.COM').href, 'https://a.com/');
  assert.equal(checkUrl('https://a.com/a b').href, 'https://a.com/a%20b');
});

test('parseArgs validates options', () => {
  assert.deepEqual(parseArgs(['https://a.com', '--platforms', 'ios']).platforms, 'ios');
  assert.equal(parseArgs(['https://a.com']).segments, 6);
  assert.throws(() => parseArgs(['--platforms', 'windows']));
  assert.throws(() => parseArgs(['--segments', '0']));
  assert.throws(() => parseArgs(['--segments', '13']));
  assert.throws(() => parseArgs(['--segments', '2.5']));
  assert.throws(() => parseArgs(['--bogus']));
  assert.throws(() => parseArgs(['--ios-device', 'a\nb']));
});

test('segmentPlan reaches the page bottom', () => {
  for (const [h, vh] of [[500, 700], [700, 700], [1400, 700], [1401, 700], [3000, 800], [9999, 640]]) {
    const { needed } = segmentPlan(h, vh, 99);
    const lastTop = (needed - 1) * 0.9 * vh;
    assert.ok(lastTop + vh >= h, 'covers bottom for ' + h + '/' + vh);
    if (needed > 1) assert.ok((needed - 2) * 0.9 * vh + vh < h, 'no extra screen for ' + h + '/' + vh);
  }
  assert.equal(segmentPlan(9999, 640, 6).count, 6);
});

test('slug is filesystem safe and ordered', () => {
  assert.equal(slug('https://a.com/san-pham/ao?x=1', 0), '01-a-com-san-pham-ao');
  assert.equal(slug('https://a.com/ti%E1%BA%BFng-vi%E1%BB%87t.html', 11), '12-a-com-tieng-viet-html');
  assert.equal(slug('https://a.com/%C4%91%C6%B0%E1%BB%9Dng', 0), '01-a-com-duong');
  assert.equal(slug('https://a.com/', 1), '02-a-com');
});

test('readUrls and maxSegments read the workflow env', () => {
  process.env.URLS = 'https://a.com/x\nhttps://b.vn/\n';
  assert.deepEqual(readUrls(), ['https://a.com/x', 'https://b.vn/']);
  process.env.MAX_SEGMENTS = '40';
  assert.equal(maxSegments(), 12);
  process.env.MAX_SEGMENTS = 'abc';
  assert.equal(maxSegments(), 6);
});
