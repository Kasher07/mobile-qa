// Downloads app.tgz.enc from the release named by ASSET_TAG, decrypts it with APP_QA_KEY (hex, 32 bytes) and unpacks
// it into ./app. Format: 12-byte IV, 16-byte GCM tag, ciphertext. Never prints the key.
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';

const tag = process.env.ASSET_TAG || '';
const keyHex = process.env.APP_QA_KEY || '';
if (!/^app-qa-[A-Za-z0-9-]{4,80}$/.test(tag)) throw new Error('bad ASSET_TAG');
if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('APP_QA_KEY missing or malformed');
const tmp = process.env.RUNNER_TEMP || '.';
execFileSync('gh', ['release', 'download', tag, '-R', process.env.GITHUB_REPOSITORY, '-p', 'app.tgz.enc', '-D', tmp, '--clobber'], { stdio: 'inherit' });
const blob = fs.readFileSync(tmp + '/app.tgz.enc');
if (blob.length < 29) throw new Error('encrypted app is truncated');
const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), blob.subarray(0, 12), { authTagLength: 16 });
d.setAuthTag(blob.subarray(12, 28));
const plain = Buffer.concat([d.update(blob.subarray(28)), d.final()]);
fs.writeFileSync(tmp + '/app.tgz', plain);
fs.mkdirSync('app', { recursive: true });
execFileSync('tar', ['-xzf', tmp + '/app.tgz', '-C', 'app'], { stdio: 'inherit' });
fs.rmSync(tmp + '/app.tgz');
console.log('app unpacked: ' + fs.readdirSync('app').length + ' entries, ' + plain.length + ' bytes');
