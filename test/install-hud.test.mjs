import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../plugins/orchestra/scripts/install-hud.mjs');

// Each test gets a throw-away plugin tree (script + stub lib/ and hud/) and a throw-away
// CLAUDE_CONFIG_DIR / ORCHESTRA_HOME, so the real ~/.claude is never touched.
function makeEnv(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-hud-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'lib', 'sub'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'hud'), { recursive: true });
  fs.copyFileSync(realScript, path.join(plugin, 'scripts', 'install-hud.mjs'));
  fs.writeFileSync(path.join(plugin, 'lib', 'collect.mjs'), '// stub v1\n');
  fs.writeFileSync(path.join(plugin, 'lib', 'sub', 'deep.mjs'), '// deep\n');
  fs.writeFileSync(path.join(plugin, 'hud', 'statusline.mjs'), '// stub statusline\n');
  fs.writeFileSync(path.join(plugin, 'hud', 'subagent-rows.mjs'), '// stub rows\n');

  const claudeDir = path.join(root, 'claude');
  const home = path.join(root, 'home');
  fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.json');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [path.join(plugin, 'scripts', 'install-hud.mjs'), ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, ORCHESTRA_HOME: home },
      encoding: 'utf8',
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const readConfig = () => JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const backups = () => fs.readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.orchestra-backup-'));
  return { root, plugin, claudeDir, home, settingsPath, run, readSettings, readConfig, backups };
}

const USER_STATUS = { type: 'command', command: 'echo user-status', padding: 1 };
const baseSettings = () => ({
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  statusLine: USER_STATUS,
  hooks: { Stop: [] },
});

test('install: copies runtime, backs up, chains previous statusLine, keeps other keys', (t) => {
  const e = makeEnv(t);
  const original = `${JSON.stringify(baseSettings(), null, 2)}\n`;
  fs.writeFileSync(e.settingsPath, original);

  const r = e.run('install');
  assert.equal(r.code, 0, r.stderr);

  assert.equal(fs.readFileSync(path.join(e.home, 'lib', 'collect.mjs'), 'utf8'), '// stub v1\n');
  assert.equal(fs.readFileSync(path.join(e.home, 'lib', 'sub', 'deep.mjs'), 'utf8'), '// deep\n');
  assert.ok(fs.existsSync(path.join(e.home, 'hud', 'statusline.mjs')));
  assert.ok(fs.existsSync(path.join(e.home, 'hud', 'subagent-rows.mjs')));

  const [backup] = e.backups();
  assert.ok(backup, 'backup file created');
  assert.equal(fs.readFileSync(path.join(e.claudeDir, backup), 'utf8'), original);

  const raw = fs.readFileSync(e.settingsPath, 'utf8');
  assert.ok(raw.endsWith('}\n'), 'trailing newline');
  assert.ok(raw.includes('\n  "model"'), '2-space indent');
  const s = JSON.parse(raw);
  assert.deepEqual(s.statusLine, {
    type: 'command',
    command: `node "${path.join(e.home, 'hud', 'statusline.mjs')}"`,
    padding: 0,
    refreshInterval: 2,
  });
  assert.deepEqual(s.subagentStatusLine, {
    type: 'command',
    command: `node "${path.join(e.home, 'hud', 'subagent-rows.mjs')}"`,
  });
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.permissions, { allow: ['Bash(ls:*)'] });
  assert.deepEqual(s.hooks, { Stop: [] });
  assert.deepEqual(Object.keys(s).slice(0, 4), ['model', 'permissions', 'statusLine', 'hooks']);

  assert.deepEqual(e.readConfig(), { chain: 'echo user-status', chainOriginal: USER_STATUS });
});

test('install is idempotent: second run keeps the saved chain', (t) => {
  const e = makeEnv(t);
  fs.writeFileSync(e.settingsPath, `${JSON.stringify(baseSettings(), null, 2)}\n`);

  assert.equal(e.run('install').code, 0);
  const afterFirst = e.readSettings();
  assert.equal(e.run('install').code, 0);

  assert.deepEqual(e.readSettings(), afterFirst);
  assert.deepEqual(e.readConfig(), { chain: 'echo user-status', chainOriginal: USER_STATUS });
  assert.ok(!e.readConfig().chain.includes('orchestra'), 'chain is never our own command');
});

test('install without settings.json creates it and has no chain', (t) => {
  const e = makeEnv(t);
  const r = e.run('install');
  assert.equal(r.code, 0, r.stderr);
  const s = e.readSettings();
  assert.ok(s.statusLine.command.includes('statusline.mjs'));
  assert.equal(e.backups().length, 0);
  assert.equal(e.readConfig().chain, undefined);
});

test('--dry-run prints before/after and changes nothing', (t) => {
  const e = makeEnv(t);
  const original = `${JSON.stringify(baseSettings(), null, 2)}\n`;
  fs.writeFileSync(e.settingsPath, original);

  const r = e.run('install', '--dry-run');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /statusLine/);
  assert.match(r.stdout, /subagentStatusLine/);
  assert.match(r.stdout, /echo user-status/);
  assert.match(r.stdout, /statusline\.mjs/);

  assert.equal(fs.readFileSync(e.settingsPath, 'utf8'), original);
  assert.equal(e.backups().length, 0);
  assert.ok(!fs.existsSync(e.home), 'ORCHESTRA_HOME not created');
});

test('uninstall restores the original statusLine and removes subagentStatusLine, files stay', (t) => {
  const e = makeEnv(t);
  fs.writeFileSync(e.settingsPath, `${JSON.stringify(baseSettings(), null, 2)}\n`);
  e.run('install');

  const r = e.run('uninstall');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(e.readSettings(), baseSettings());
  assert.ok(fs.existsSync(path.join(e.home, 'hud', 'statusline.mjs')), 'files left in place');
  assert.ok(fs.existsSync(path.join(e.home, 'config.json')));
});

test('uninstall with no prior statusLine deletes it', (t) => {
  const e = makeEnv(t);
  fs.writeFileSync(e.settingsPath, `${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
  e.run('install');
  assert.ok(e.readSettings().statusLine);

  assert.equal(e.run('uninstall').code, 0);
  assert.deepEqual(e.readSettings(), { model: 'opus' });
});

test('uninstall leaves a foreign statusLine alone', (t) => {
  const e = makeEnv(t);
  const foreign = { model: 'opus', statusLine: { type: 'command', command: 'echo other' } };
  fs.writeFileSync(e.settingsPath, `${JSON.stringify(foreign, null, 2)}\n`);
  const r = e.run('uninstall');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(e.readSettings(), foreign);
});

test('user subagentStatusLine is restored on uninstall', (t) => {
  const e = makeEnv(t);
  const mine = { type: 'command', command: 'echo my-rows' };
  fs.writeFileSync(e.settingsPath, `${JSON.stringify({ subagentStatusLine: mine }, null, 2)}\n`);
  e.run('install');
  assert.ok(e.readSettings().subagentStatusLine.command.includes('subagent-rows.mjs'));
  e.run('uninstall');
  assert.deepEqual(e.readSettings(), { subagentStatusLine: mine });
});

test('status reports state in English', (t) => {
  const e = makeEnv(t);
  fs.writeFileSync(e.settingsPath, `${JSON.stringify(baseSettings(), null, 2)}\n`);

  let r = e.run('status');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /not installed/);
  assert.ok(r.stdout.includes(e.home));

  e.run('install');
  r = e.run('status');
  assert.match(r.stdout, /Orchestra HUD: installed/);
  assert.match(r.stdout, /echo user-status/);
  assert.ok(r.stdout.includes(e.home));
});

test('sync: no-op when not installed, re-copies when installed, never touches settings', (t) => {
  const e = makeEnv(t);
  const original = `${JSON.stringify(baseSettings(), null, 2)}\n`;
  fs.writeFileSync(e.settingsPath, original);

  assert.equal(e.run('sync').code, 0);
  assert.ok(!fs.existsSync(e.home), 'sync does not create ORCHESTRA_HOME');

  e.run('install');
  const installed = fs.readFileSync(e.settingsPath, 'utf8');
  fs.writeFileSync(path.join(e.plugin, 'lib', 'collect.mjs'), '// stub v2\n');
  fs.writeFileSync(path.join(e.plugin, 'hud', 'extra.mjs'), '// new\n');

  const r = e.run('sync', '--quiet');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(fs.readFileSync(path.join(e.home, 'lib', 'collect.mjs'), 'utf8'), '// stub v2\n');
  assert.ok(fs.existsSync(path.join(e.home, 'hud', 'extra.mjs')));
  assert.equal(fs.readFileSync(e.settingsPath, 'utf8'), installed);
});

test('sync --quiet prints nothing and exits 0 even when the plugin tree is broken', (t) => {
  const e = makeEnv(t);
  e.run('install');
  fs.rmSync(path.join(e.plugin, 'lib'), { recursive: true });
  const r = e.run('sync', '--quiet');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('invalid settings.json: install fails with exit 1 and leaves the file untouched', (t) => {
  const e = makeEnv(t);
  fs.writeFileSync(e.settingsPath, '{ not json');
  const r = e.run('install');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /JSON/);
  assert.equal(fs.readFileSync(e.settingsPath, 'utf8'), '{ not json');
  assert.equal(e.backups().length, 0);
});

test('unknown command exits 1 with usage', (t) => {
  const e = makeEnv(t);
  const r = e.run('bogus');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Usage/);
});

test('codexModel in config.json survives install, repeat install and uninstall', (t) => {
  const e = makeEnv(t);
  fs.writeFileSync(e.settingsPath, `${JSON.stringify(baseSettings(), null, 2)}\n`);
  fs.mkdirSync(e.home, { recursive: true });
  fs.writeFileSync(path.join(e.home, 'config.json'), `${JSON.stringify({ codexModel: 'gpt-6.1-sol' }, null, 2)}\n`);

  assert.equal(e.run('install').code, 0);
  assert.deepEqual(e.readConfig(), { codexModel: 'gpt-6.1-sol', chain: 'echo user-status', chainOriginal: USER_STATUS });

  assert.equal(e.run('install').code, 0);
  assert.deepEqual(e.readConfig(), { codexModel: 'gpt-6.1-sol', chain: 'echo user-status', chainOriginal: USER_STATUS });

  assert.equal(e.run('uninstall').code, 0);
  assert.equal(e.readConfig().codexModel, 'gpt-6.1-sol');
  assert.deepEqual(e.readSettings(), baseSettings());
});

test('codexModel survives install when there is no statusLine to chain', (t) => {
  const e = makeEnv(t);
  fs.writeFileSync(e.settingsPath, `${JSON.stringify({ model: 'opus' }, null, 2)}\n`);
  fs.mkdirSync(e.home, { recursive: true });
  // A stale chain from an earlier install is dropped, the unrelated codexModel key is not.
  fs.writeFileSync(
    path.join(e.home, 'config.json'),
    `${JSON.stringify({ codexModel: 'gpt-6.2', chain: 'echo stale', chainOriginal: USER_STATUS }, null, 2)}\n`,
  );

  assert.equal(e.run('install').code, 0);
  assert.deepEqual(e.readConfig(), { codexModel: 'gpt-6.2' });
});
