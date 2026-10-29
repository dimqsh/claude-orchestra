#!/usr/bin/env node
// Installs the orchestra HUD into Claude Code settings.json.
//
//   install-hud.mjs install|uninstall|status|sync [--dry-run] [--quiet]
//
// install:   copy ../lib and ../hud to <ORCHESTRA_HOME>, point statusLine and
//            subagentStatusLine at them, remember the previous statusLine as a chain.
// uninstall: restore the previous statusLine, drop ours. Files in ORCHESTRA_HOME stay.
// status:    report the current state.
// sync:      re-copy lib/ and hud/ if already installed; never touches settings.json.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const orchestraHome = process.env.ORCHESTRA_HOME || path.join(claudeConfigDir, 'orchestra');
const settingsPath = path.join(claudeConfigDir, 'settings.json');
const configPath = path.join(orchestraHome, 'config.json');

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIRS = ['lib', 'hud'];

const statusScript = path.join(orchestraHome, 'hud', 'statusline.mjs');
const subagentScript = path.join(orchestraHome, 'hud', 'subagent-rows.mjs');
const OUR_STATUS_LINE = { type: 'command', command: `node "${statusScript}"`, padding: 0, refreshInterval: 2 };
const OUR_SUBAGENT_LINE = { type: 'command', command: `node "${subagentScript}"` };

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const command = argv.find((a) => !a.startsWith('--'));
const dryRun = flags.has('--dry-run');
const quiet = flags.has('--quiet');

const out = (line = '') => {
  if (!quiet) console.log(line);
};

class UserError extends Error {}

// ---------- helpers ----------

function isOurs(cmd, name) {
  if (typeof cmd !== 'string') return false;
  const norm = cmd.replaceAll('\\', '/');
  return (
    norm.includes(`orchestra/hud/${name}.mjs`) ||
    norm.includes(path.join(orchestraHome, 'hud', `${name}.mjs`).replaceAll('\\', '/'))
  );
}

const isOurStatus = (line) => isOurs(line?.command, 'statusline');
const isOurSubagent = (line) => isOurs(line?.command, 'subagent-rows');

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError(`${file} is not valid JSON; nothing was changed.`);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function show(value) {
  if (value === undefined) return '(none)';
  return JSON.stringify(value, (_k, v) => (typeof v === 'string' && v.length > 240 ? `${v.slice(0, 240)}… (+${v.length - 240} chars)` : v));
}

function copyRuntime() {
  for (const dir of RUNTIME_DIRS) {
    const src = path.join(pluginRoot, dir);
    if (!isDir(src)) throw new UserError(`Directory ${src} not found: the plugin installation is incomplete.`);
  }
  for (const dir of RUNTIME_DIRS) {
    fs.cpSync(path.join(pluginRoot, dir), path.join(orchestraHome, dir), { recursive: true, force: true });
  }
}

function backupSettings() {
  if (!fs.existsSync(settingsPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${settingsPath}.orchestra-backup-${stamp}`;
  fs.copyFileSync(settingsPath, backup);
  return backup;
}

function printDiff(before, after) {
  for (const key of ['statusLine', 'subagentStatusLine']) {
    out(`${key}:`);
    out(`  before: ${show(before[key])}`);
    out(`  after:  ${show(after[key])}`);
  }
}

// ---------- commands ----------

function planInstall(settings, config) {
  const next = { ...settings };
  const cfg = { ...config };

  const sl = settings.statusLine;
  if (sl && !isOurStatus(sl)) {
    const cmd = typeof sl === 'object' ? sl.command : undefined;
    if (typeof cmd === 'string') cfg.chain = cmd;
    else delete cfg.chain;
    cfg.chainOriginal = sl;
  } else if (!sl) {
    delete cfg.chain;
    delete cfg.chainOriginal;
  }

  const sub = settings.subagentStatusLine;
  if (sub && !isOurSubagent(sub)) cfg.subagentOriginal = sub;
  else if (!sub) delete cfg.subagentOriginal;

  next.statusLine = { ...OUR_STATUS_LINE };
  next.subagentStatusLine = { ...OUR_SUBAGENT_LINE };
  return { next, cfg };
}

function install() {
  const settings = readJson(settingsPath, {});
  const config = readJson(configPath, {});
  const { next, cfg } = planInstall(settings, config);

  if (dryRun) {
    out(`[dry-run] ${settingsPath}`);
    printDiff(settings, next);
    if (cfg.chainOriginal && cfg.chainOriginal !== config.chainOriginal) {
      out(`The existing status line will be saved to ${configPath} and run first (chain).`);
    }
    out(`lib/ and hud/ will be copied to ${orchestraHome}.`);
    out('Nothing was changed.');
    return;
  }

  copyRuntime();
  const backup = backupSettings();
  writeJsonAtomic(configPath, cfg);
  writeJsonAtomic(settingsPath, next);

  out(`Done: HUD installed in ${orchestraHome}.`);
  if (backup) out(`Settings backup: ${backup}`);
  if (cfg.chain) out(`Existing status line saved as chain: ${show(cfg.chain)}`);
  out('To roll back: node install-hud.mjs uninstall');
}

function planUninstall(settings, config) {
  const next = { ...settings };
  if (isOurStatus(settings.statusLine)) {
    if (config.chainOriginal) next.statusLine = config.chainOriginal;
    else delete next.statusLine;
  }
  if (isOurSubagent(settings.subagentStatusLine)) {
    if (config.subagentOriginal) next.subagentStatusLine = config.subagentOriginal;
    else delete next.subagentStatusLine;
  }
  return next;
}

function uninstall() {
  const settings = readJson(settingsPath, {});
  const config = readJson(configPath, {});
  const next = planUninstall(settings, config);

  if (dryRun) {
    out(`[dry-run] ${settingsPath}`);
    printDiff(settings, next);
    out('Nothing was changed.');
    return;
  }

  if (!isOurStatus(settings.statusLine) && !isOurSubagent(settings.subagentStatusLine)) {
    out('HUD is not installed, nothing to remove.');
    return;
  }
  const backup = backupSettings();
  writeJsonAtomic(settingsPath, next);
  out('Done: status line restored to its previous state.');
  if (backup) out(`Settings backup: ${backup}`);
  out(`Files in ${orchestraHome} were left in place.`);
}

function status() {
  const settings = readJson(settingsPath, {});
  const config = readJson(configPath, {});
  const installed = isOurStatus(settings.statusLine);
  const sub = settings.subagentStatusLine;

  out(`Orchestra HUD: ${installed ? 'installed' : 'not installed'}`);
  out(`settings.json: ${settingsPath}`);
  out(`ORCHESTRA_HOME: ${orchestraHome}`);
  out(`HUD files: ${isDir(path.join(orchestraHome, 'hud')) ? 'copied' : 'not copied'}`);
  out(`Existing status line (chain): ${config.chain ? show(config.chain) : 'none'}`);
  out(`Subagent status line: ${isOurSubagent(sub) ? 'orchestra' : sub ? 'other' : 'none'}`);
}

function sync() {
  if (!isDir(path.join(orchestraHome, 'hud'))) {
    out(`HUD is not installed (no ${path.join(orchestraHome, 'hud')}); sync skipped.`);
    return;
  }
  copyRuntime();
  out(`HUD files updated in ${orchestraHome}.`);
}

// ---------- main ----------

const commands = { install, uninstall, status, sync };

try {
  if (!commands[command]) {
    throw new UserError('Usage: install-hud.mjs install|uninstall|status|sync [--dry-run] [--quiet]');
  }
  commands[command]();
} catch (err) {
  if (command === 'sync' && quiet) process.exit(0);
  console.error(err instanceof UserError ? err.message : `Error: ${err.message}`);
  process.exit(1);
}
