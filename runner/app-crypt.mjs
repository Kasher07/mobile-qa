// AES-256-GCM with APP_QA_KEY (hex, 32 bytes) for one file: `seal <in> <out>` / `open <in> <out>`.
// Format as app-fetch.mjs: IV(12) | tag(16) | ciphertext. Used to pass the built app between jobs as an artifact that
// holds nothing readable.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [mode, src, dest] = process.argv.slice(2);
const keyHex = process.env.APP_QA_KEY || '';
if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('APP_QA_KEY missing or malformed');
if (!src || !dest || !['seal', 'open'].includes(mode)) throw new Error('usage: app-crypt.mjs seal|open <in> <out>');
const key = Buffer.from(keyHex, 'hex');
const data = fs.readFileSync(src);
fs.mkdirSync(path.dirname(dest), { recursive: true });
if (mode === 'seal') {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(data), c.final()]);
  fs.writeFileSync(dest, Buffer.concat([iv, c.getAuthTag(), enc]));
} else {
  if (data.length < 29) throw new Error('sealed file is truncated');
  const d = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(data.subarray(12, 28));
  fs.writeFileSync(dest, Buffer.concat([d.update(data.subarray(28)), d.final()]));
}
console.log(mode + ' ' + path.basename(dest) + ': ' + fs.statSync(dest).size + ' bytes');
