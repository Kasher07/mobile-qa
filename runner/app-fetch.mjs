// Downloads app.tgz.enc from the release named by ASSET_TAG, decrypts it with APP_QA_KEY (hex, 32 bytes) and unpacks
// it into ./app. Format: 12-byte IV, 16-byte GCM tag, ciphertext. Never prints the key.
// With SHELL_PLATFORM (ios / android) listed in REUSE, also fetches shell-<platform>.tgz.enc (the release build of an
// earlier run, for a JS-only change) and leaves it decrypted at $RUNNER_TEMP/shell-<platform>.tgz.
import { execFileSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import fs from 'node:fs';

const tag = process.env.ASSET_TAG || '';
const keyHex = process.env.APP_QA_KEY || '';
if (!/^app-qa-[A-Za-z0-9-]{4,80}$/.test(tag)) throw new Error('bad ASSET_TAG');
if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('APP_QA_KEY missing or malformed');
const tmp = process.env.RUNNER_TEMP || '.';

const repo = process.env.GITHUB_REPOSITORY || process.env.QA_REPO || '';
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error('bad repository');
function fetchDecrypted(asset) {
  // GitHub runners use gh; elsewhere (Codemagic) the release of the public repo is fetched over HTTPS.
  if (process.env.GH_TOKEN) execFileSync('gh', ['release', 'download', tag, '-R', repo, '-p', asset, '-D', tmp, '--clobber'], { stdio: 'inherit' });
  else execFileSync('curl', ['-fsSL', '--retry', '3', '-o', tmp + '/' + asset, 'https://github.com/' + repo + '/releases/download/' + tag + '/' + asset], { stdio: 'inherit' });
  const blob = fs.readFileSync(tmp + '/' + asset);
  if (blob.length < 29) throw new Error(asset + ' is truncated');
  const d = createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), blob.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(blob.subarray(12, 28));
  const plain = Buffer.concat([d.update(blob.subarray(28)), d.final()]);
  fs.rmSync(tmp + '/' + asset);
  return plain;
}

const plain = fetchDecrypted('app.tgz.enc');
fs.writeFileSync(tmp + '/app.tgz', plain);
fs.mkdirSync('app', { recursive: true });
execFileSync('tar', ['-xzf', tmp + '/app.tgz', '-C', 'app'], { stdio: 'inherit' });
fs.rmSync(tmp + '/app.tgz');
console.log('app unpacked: ' + fs.readdirSync('app').length + ' entries, ' + plain.length + ' bytes');

const platform = process.env.SHELL_PLATFORM || '';
const reuse = (process.env.REUSE || '').split(',');
if (/^(ios|android)$/.test(platform) && reuse.includes(platform)) {
  const shell = fetchDecrypted('shell-' + platform + '.tgz.enc');
  fs.writeFileSync(tmp + '/shell-' + platform + '.tgz', shell);
  console.log('reused ' + platform + ' build fetched: ' + shell.length + ' bytes');
}
