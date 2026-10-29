// Deterministically deliver signals at asynchronous-write and spawn boundaries.
// This probe runs in its own process so builtin instrumentation cannot leak to tests.
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const [phase, signal, cwd] = process.argv.slice(2);
if (phase === 'before-spawn') {
  const rename = fs.rename;
  let delivered = false;
  fs.rename = async (...args) => {
    await rename(...args);
    if (!delivered) { delivered = true; process.emit(signal); }
  };
} else if (phase === 'during-spawn') {
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    process.emit(signal);
    return spawn(...args);
  };
} else throw new Error('Unknown signal phase');
syncBuiltinESMExports();
const { runCodexTask } = await import('../../plugins/orchestra/scripts/codex-task.mjs');
const result = await runCodexTask(['--cwd', cwd], '#11 interrupted');
console.log(result.output);
process.exitCode = result.exitCode;
