#!/usr/bin/env node
import { discover } from '../lib/discover.mjs';
import { refreshBenchmarks } from '../lib/benchmarks.mjs';

const commands = {
  benchmarks: async args => {
    if (args.some(arg => arg !== '--force')) throw new Error('Usage: models.mjs benchmarks [--force]');
    const result = await refreshBenchmarks({ force: args.includes('--force') });
    console.log(`matched: ${result.matched.join(', ')}`);
    console.log(`unmatched: ${result.unmatched.join(', ')}`);
    console.log(`source: ${result.source.join(', ')}`);
    for (const warning of result.warnings) console.error(`Warning: ${warning}`);
  },
  discover: async args => {
    if (args.some(arg => arg !== '--force')) throw new Error('Usage: models.mjs discover [--force]');
    const result = await discover({ force: args.includes('--force') });
    console.log(`added: ${result.added.join(', ')}`);
    console.log(`unavailable: ${result.unavailable.join(', ')}`);
  },
};

try {
  const [command, ...args] = process.argv.slice(2);
  if (!Object.hasOwn(commands, command)) throw new Error(`Usage: models.mjs <${Object.keys(commands).join('|')}>`);
  await commands[command](args);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}
