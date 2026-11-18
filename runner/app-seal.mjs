// Packs a results folder (argv[2], e.g. out/ios) and encrypts it with APP_QA_KEY (fresh IV) into sealed/<name>.enc,
// so the public run's artifacts hold nothing readable. Format as app-fetch.mjs: IV(12) | tag(16) | ciphertext.
import { execFileSync } from 'node:child_process';
import { createCipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const keyHex = process.env.APP_QA_KEY || '';
if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('APP_QA_KEY missing or malformed');
const name = path.basename(dir);
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync('sealed', { recursive: true });
const tgz = path.join(process.env.RUNNER_TEMP || '.', name + '.tgz');
execFileSync('tar', ['-czf', tgz, '-C', dir, '.']);
const iv = randomBytes(12);
const c = createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv, { authTagLength: 16 });
const enc = Buffer.concat([c.update(fs.readFileSync(tgz)), c.final()]);
fs.writeFileSync(path.join('sealed', name + '.enc'), Buffer.concat([iv, c.getAuthTag(), enc]));
fs.rmSync(tgz);
console.log('sealed ' + name + ': ' + enc.length + ' bytes');
