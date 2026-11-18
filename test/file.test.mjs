import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readUrlFile } from '../bin/mobile-qa.mjs';

test('--file reads a markdown bullet list', () => {
  const f = path.join(os.tmpdir(), 'mq-pages-md-' + process.pid + '.md');
  fs.writeFileSync(f, '# Pages\n\nmobile-qa reads this list: `--file x.md`.\n\n- https://a.com/\n- <https://a.com/b>\n');
  try {
    assert.deepEqual(readUrlFile(f), ['https://a.com/', 'https://a.com/b']);
  } finally {
    fs.unlinkSync(f);
  }
});

test('--file skips comments and blank lines (CRLF too)', () => {
  const f = path.join(os.tmpdir(), 'mq-pages-' + process.pid + '.txt');
  fs.writeFileSync(f, '# Key pages\r\nhttps://a.com/\r\n\r\n  https://a.com/b  \r\n# end\r\n');
  try {
    assert.deepEqual(readUrlFile(f), ['https://a.com/', 'https://a.com/b']);
  } finally {
    fs.unlinkSync(f);
  }
});
