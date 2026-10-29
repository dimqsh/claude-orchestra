#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runWorktree } from '../lib/git.mjs';

const execute = promisify(execFile);
export async function runWorktreeCli(argv = process.argv.slice(2)) {
  const args = [...argv];
  function option(name) {
    const at = args.indexOf(name);
    if (at < 0) return undefined;
    if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Cannot run command: missing value for ${name}`);
    return args.splice(at, 2)[1];
  }
  function flag(name) {
    const at = args.indexOf(name);
    if (at < 0) return false;
    args.splice(at, 1); return true;
  }
  const options = { cwd: option('--cwd') || process.cwd(), from: option('--from'), into: option('--into'),
    allowDirty: flag('--allow-dirty'), stat: flag('--stat'), force: flag('--force'), json: flag('--json') };
  const [command, id] = args;
  const commands = { init: 1, create: 2, path: 2, diff: 2, refresh: 2, accept: 2, land: 1, cleanup: 1, status: 1 };
  if (!commands[command] || args.length !== commands[command] || args.some(value => value.startsWith('--'))) {
    throw new Error('Cannot run command: unknown command or wrong arguments. Usage: worktree [--cwd dir] init|create|path|diff|refresh|accept|land|cleanup|status [id]');
  }
  for (const [key, allowed] of Object.entries({ from: 'create', into: 'accept', allowDirty: 'init', stat: 'diff', force: 'cleanup', json: 'status' })) {
    if (options[key] && command !== allowed) throw new Error(`Cannot run ${command}: ${key} is only valid for ${allowed}`);
  }
  options.id = id;
  options.updateBoard = async (cwd, fields) => {
    const bin = process.env.ORCHESTRA_BOARD_BIN || fileURLToPath(new URL('./board.mjs', import.meta.url));
    try { await execute(process.execPath, [bin, '--cwd', cwd, ...fields], { timeout: 10000, maxBuffer: 1024 * 1024 }); }
    catch (error) { console.error(`Warning: board not updated: ${String(error.stderr || error.message).replace(/[\r\n]+/g, ' ').trim()}`); }
  };
  return runWorktree(command, options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { const output = await runWorktreeCli(); if (output !== undefined) console.log(output); }
  catch (error) {
    console.error(`Error: ${error.exitCode === 2 ? error.message : String(error.stderr || error.message).replace(/[\r\n]+/g, ' ').trim()}`);
    process.exitCode = error.exitCode || 1;
  }
}
