import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// test/index.mjs loads every test file into one process: never mutate process.env here.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'orchestra');
const { projectSlug } = await import(join(root, 'lib', 'paths.mjs'));

// Rule checked against a real ~/.claude/projects dir: first 200 chars of the slug, '-', then
// Math.abs(Java-style string hash) in base36.
test('projectSlug matches Claude Code naming for paths over 200 chars', () => {
  const path = '/private/tmp/claude-501/-Users-you-Library-Application-Support-Claude-scratch-workspaces-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002-scratch-2026-01-01-abc123/11111111-2222-4333-8444-555555555555/scratchpad/orchestra-demo';
  const slug = projectSlug(path);
  assert.equal(slug.length, 207);
  assert.ok(slug.endsWith('-11111111-22-1png48'), slug.slice(-30));
  assert.equal(projectSlug('/Users/me/proj'), '-Users-me-proj');
});

test('board CLI works in a directory with a very long path', () => {
  const home = mkdtempSync(join(tmpdir(), 'orchestra-long-'));
  let cwd = mkdtempSync(join(tmpdir(), 'orchestra-cwd-'));
  for (let i = 0; i < 6; i++) cwd = join(cwd, `segment-${i}-${'x'.repeat(40)}`);
  mkdirSync(cwd, { recursive: true });
  const board = (...args) => execFileSync(process.execPath, [join(root, 'scripts', 'board.mjs'), '--cwd', cwd, ...args],
    { env: { ...process.env, ORCHESTRA_HOME: home }, encoding: 'utf8' });
  board('init', 'long path');
  board('add', '1', 'task', '--exec', 'codex');
  board('set', '1', 'running');
  assert.equal(JSON.parse(board('json')).tasks[0].attempts, 1);
  assert.match(board('show', '--width', '100'), /#1 task/);
});
