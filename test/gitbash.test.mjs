import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitBashPaths, checkPrivateTarget } from '../runner/private.mjs';

test('Git Bash rewrote the paths: they come back as site paths, also when a shell split them at the space', () => {
  const root = 'C:\\Program Files\\Git';
  assert.deepEqual(gitBashPaths(['C:/Program Files/Git/admin', 'C:/Program Files/Git/admin/users'], root), ['/admin', '/admin/users']);
  assert.deepEqual(gitBashPaths(['C:/Program', 'Files/Git/admin', 'C:/Program', 'Files/Git/admin/users'], root), ['/admin', '/admin/users']);
  assert.deepEqual(gitBashPaths(['C:/Program Files/Git/', 'C:/Program Files/Git'], root), ['/', '/']);
  assert.deepEqual(gitBashPaths(['c:\\program files\\git\\admin'], 'C:\\Program Files\\Git\\bin'), ['/admin']);
  assert.deepEqual(gitBashPaths(['D:/Git/admin'], 'D:/Git'), ['/admin']);
});

test('paths Git Bash left alone pass through unchanged, and nothing else becomes a path', () => {
  const root = 'C:/Program Files/Git';
  assert.deepEqual(gitBashPaths(['/#sales', '/admin', 'https://x.example/a'], root), ['/#sales', '/admin', 'https://x.example/a']);
  assert.deepEqual(gitBashPaths(['C:/Program', 'Other/x', 'C:/Windows/x'], root), ['C:/Program', 'Other/x', 'C:/Windows/x']);
  // the guard still judges the result: a rewritten "//evil.example" stays refused
  assert.throws(() => checkPrivateTarget('https://app.example.com', gitBashPaths(['C:/Program Files/Git//evil.example/x'], root)), /only paths on the kit-qa site/);
  assert.deepEqual(checkPrivateTarget('https://app.example.com', gitBashPaths(['C:/Program Files/Git/admin'], root)).paths, ['/admin']);
});
