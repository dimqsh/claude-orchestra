#!/usr/bin/env node
import { discover } from '../lib/discover.mjs';
import { refreshBenchmarks } from '../lib/benchmarks.mjs';

const commands = {
  brief: async args => {
    const { readCatalog, TASK_TYPES } = await import('../lib/catalog.mjs');
    const { readLimits } = await import('../lib/limits.mjs');
    const { history } = await import('../lib/collect.mjs');
    const { ladder, untested } = await import('../lib/route.mjs');
    const usage = 'Usage: models.mjs brief [--types bug,docs]';
    if (args.length && (args.length !== 2 || args[0] !== '--types')) throw new Error(usage);
    const types = args.length ? [...new Set(args[1].split(','))] : TASK_TYPES;
    if (!types.length || types.some(type => !TASK_TYPES.includes(type))) throw new Error(usage);
    const [catalog, limits, past] = await Promise.all([readCatalog(), readLimits(), history()]);
    const lines = [];
    let fullyUntested;
    for (const type of types) {
      const rows = ladder(type, catalog, limits, past);
      const pending = new Set(untested(type, catalog, limits, past));
      fullyUntested = new Set(fullyUntested === undefined ? pending : [...fullyUntested].filter(id => pending.has(id)));
      if (!rows.length) lines.push(`${type} ${pending.size ? 'no evidence yet' : 'no available models'}`);
      for (const row of rows) lines.push(`${type} ${row.rung}. ${row.id}${row.effort ? `@${row.effort}` : ''} · ${Math.round(row.score.value)} · ${row.score.evidence} · ${row.cost}${row.lowLimit ? ' · low limit' : ''}`);
    }
    if (fullyUntested.size) {
      const ids = [...fullyUntested];
      lines.push(`untested: ${ids.join(', ')} (models.mjs bench --models ${ids.join(',')})`);
    }
    lines.push(`Limits: ${Object.entries(limits).map(([provider, windows]) =>
      `${provider} ${windows ? windows.map(window => `${window.usedPercent}% used/${window.name}`).join(', ') : 'unknown'}`).join(' · ')}`);
    console.log(lines.join('\n'));
  },
  benchmarks: async args => {
    if (args.some(arg => arg !== '--force')) throw new Error('Usage: models.mjs benchmarks [--force]');
    const result = await refreshBenchmarks({ force: args.includes('--force') });
    console.log(`matched: ${result.matched.join(', ')}`);
    console.log(`unmatched: ${result.unmatched.join(', ')}`);
    console.log(`source: ${result.source.join(', ')}`);
    for (const warning of result.warnings) console.error(`Warning: ${warning}`);
  },
  bench: async args => {
    const { runBenchCli } = await import('../lib/bench.mjs');
    process.exitCode = await runBenchCli(args);
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
