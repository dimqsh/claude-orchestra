import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plugin = fileURLToPath(new URL('../plugins/orchestra/', import.meta.url));
const benchUrl = new URL('../plugins/orchestra/lib/bench.mjs', import.meta.url).href;
const catalogUrl = new URL('../plugins/orchestra/lib/catalog.mjs', import.meta.url).href;
const references = fileURLToPath(new URL('fixtures/bench-ref/', import.meta.url));
const types = ['bug', 'logic', 'refactor', 'tests', 'docs', 'multi'];
const entry = (provider, model, extra = {}) => ({ id: `${provider}:${model}`, provider, model, own: null, ...extra });

async function sandbox(t, entries = [entry('codex', 'sample')], config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orchestra-bench-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  await writeFile(join(home, 'models.json'), JSON.stringify({ version: 1, models: Object.fromEntries(entries.map(e => [e.id, e])) }));
  await writeFile(join(home, 'config.json'), JSON.stringify(config));
  const env = { ...process.env, ORCHESTRA_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), PATH: '/usr/bin:/bin' };
  function run(body) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import * as bench from ${JSON.stringify(benchUrl)};
      import { readCatalog } from ${JSON.stringify(catalogUrl)};
      import { cp, access } from 'node:fs/promises';
      import { join } from 'node:path';
      const calls = [];
      const runner = async request => {
        calls.push(request);
        const type = request.input.match(/^#B-(\\w+)/)[1];
        await cp(join(${JSON.stringify(references)}, type), request.cwd, { recursive: true });
        return { code: 0, stdout: '[codex] #B-' + type + ' done · 512 tokens · 0m2s\\n', stderr: '' };
      };
      ${body}`], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    return JSON.parse(child.stdout.trim().split('\n').at(-1));
  }
  return { root, home, env, run };
}

for (const type of types) {
  test(`benchmark fixture ${type}: untouched fails, reference fix passes`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'orchestra-fixture-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const fixture = join(plugin, 'bench', type), repo = join(root, 'repo');
    await cp(join(fixture, 'repo'), repo, { recursive: true });
    assert.match(await readFile(join(fixture, 'brief.md'), 'utf8'), new RegExp(`^#B-${type} `));
    const check = () => spawnSync(process.execPath, [join(fixture, 'check.mjs'), repo], { encoding: 'utf8', timeout: 10000 });
    const red = check();
    assert.notEqual(red.status, 0, 'untouched repo must fail');
    await cp(join(references, type), repo, { recursive: true });
    const green = check();
    assert.equal(green.status, 0, green.stderr + green.stdout);
  });
}

test('bench --new is postponed while any recent unfinished board is active', async t => {
  const f = await sandbox(t, undefined, { benchAuto: true });
  await mkdir(join(f.home, 'boards'));
  await writeFile(join(f.home, 'boards', 'other-project.json'), JSON.stringify({ updatedAt: new Date().toISOString(), finishedAt: null }));
  const out = f.run(`const result = await bench.runBench({ auto: true, runner });
    const code = await bench.runBenchCli(['--new']);
    console.log(JSON.stringify({ result, code, calls, catalog: await readCatalog() }));`);
  assert.equal(out.result['codex:sample'].reason, 'board active');
  assert.equal(out.result['codex:sample'].done, false);
  assert.equal(out.code, 0);
  assert.deepEqual(out.calls, []);
  assert.equal(out.catalog.models['codex:sample'].own, null);
});

test('bench --new does nothing without benchAuto: true', async t => {
  for (const benchAuto of [undefined, false, 'true']) {
    const f = await sandbox(t, undefined, { benchAuto });
    const out = f.run(`const result = await bench.runBench({ auto: true, runner });
      const code = await bench.runBenchCli(['--new']);
      console.log(JSON.stringify({ result, code, calls }));`);
    assert.deepEqual(out, { result: {}, code: 0, calls: [] });
  }
});

test('postponement uses the 30 minute board window and provider limit above 70%', async t => {
  const f = await sandbox(t);
  await mkdir(join(f.home, 'boards', 'archive'), { recursive: true });
  for (const [name, board] of Object.entries({
    old: { updatedAt: new Date(Date.now() - 31 * 60000).toISOString(), finishedAt: null },
    finished: { updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }
  })) await writeFile(join(f.home, 'boards', `${name}.json`), JSON.stringify(board));
  await writeFile(join(f.home, 'boards', 'broken.json'), '{bad');
  await writeFile(join(f.home, 'boards', 'archive', 'active.json'), JSON.stringify({ updatedAt: new Date().toISOString() }));
  for (const [used, reason] of [[70, null], [70.1, 'low limit']]) {
    await writeFile(join(f.home, 'limits.json'), JSON.stringify({ claude: { seven_day: { used_percent: used } } }));
    assert.deepEqual(f.run(`console.log(JSON.stringify([await bench.benchPostponeReason('claude'), await bench.benchPostponeReason('codex')]));`), [reason, null]);
  }
});

test('the 150k cap stops each model run and records a partial result', async t => {
  const f = await sandbox(t, [entry('codex', 'a'), entry('codex', 'b')]);
  const out = f.run(`let active = 0, maximum = 0;
    const capped = async request => { maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      const answer = await runner(request); active--;
      return { ...answer, stdout: answer.stdout.replace('512', '75k') }; };
    const result = await bench.runBench({ models: ['a', 'codex:b'], runner: capped });
    console.log(JSON.stringify({ result, calls: calls.length, maximum, catalog: await readCatalog() }));`);
  assert.equal(out.calls, 4);
  assert.equal(out.maximum, 1);
  for (const id of ['codex:a', 'codex:b']) {
    assert.equal(out.result[id].done, false);
    assert.equal(out.result[id].reason, 'token cap');
    assert.deepEqual(Object.keys(out.result[id].byType), ['bug', 'logic']);
    assert.equal(out.catalog.models[id].own.partial, true);
    assert.equal(out.catalog.models[id].own.byType.logic.tokens, 75000);
  }
});

test('explicit runs ignore auto rules; results include tokens and seconds in own.byType', async t => {
  const f = await sandbox(t, [entry('codex', 'sample', { effort: 'high', notes: 'keep' })]);
  await mkdir(join(f.home, 'boards'));
  await writeFile(join(f.home, 'boards', 'busy.json'), JSON.stringify({ updatedAt: new Date().toISOString(), finishedAt: null }));
  const out = f.run(`const result = await bench.runBench({ models: ['sample'], runner });
    console.log(JSON.stringify({ result, calls, catalog: await readCatalog(), cleaned: await Promise.all(calls.map(c => access(c.cwd).then(() => false, () => true))) }));`);
  assert.equal(out.result['codex:sample'].done, true);
  assert.deepEqual(out.cleaned, types.map(() => true));
  const own = out.catalog.models['codex:sample'].own;
  assert.match(own.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(own.partial, false);
  assert.equal(out.catalog.models['codex:sample'].notes, 'keep');
  assert.deepEqual(Object.keys(own.byType), types);
  for (const type of types) {
    assert.deepEqual(own.byType[type], { passed: 1, total: 1, tokens: 512, seconds: 2 });
  }
  for (const call of out.calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.args[0], join(plugin, 'scripts', 'codex-task.mjs'));
    assert.deepEqual(call.args.slice(1), ['--cwd', call.cwd, '--model', 'sample', '--effort', 'high', '--write']);
    assert.equal(existsSync(join(call.cwd, 'check.mjs')), false);
  }
});

test('auto selects only unbenchmarked entries and rechecks postponement between tasks', async t => {
  const f = await sandbox(t, [entry('codex', 'old', { own: { date: '2026-01-01', byType: {} } }), entry('codex', 'new')], { benchAuto: true });
  const out = f.run(`import { mkdir, writeFile } from 'node:fs/promises';
    const result = await bench.runBench({ auto: true, runner: async request => {
      const answer = await runner(request);
      await mkdir(${JSON.stringify(join(f.home, 'boards'))});
      await writeFile(${JSON.stringify(join(f.home, 'boards', 'new.json'))}, JSON.stringify({ updatedAt: new Date().toISOString(), finishedAt: null }));
      return answer;
    }});
    console.log(JSON.stringify({ result, calls: calls.length, catalog: await readCatalog() }));`);
  assert.equal(out.calls, 1);
  assert.deepEqual(Object.keys(out.result), ['codex:new']);
  assert.equal(out.result['codex:new'].reason, 'board active');
  assert.equal(out.catalog.models['codex:new'].own.partial, true);
});

test('Claude CLI uses alias, stdin, JSON usage excluding cache reads and hidden checks', async t => {
  const f = await sandbox(t, [entry('claude', 'claude-sonnet-5-5')]);
  const out = f.run(`const result = await bench.runBench({ models: ['claude-sonnet-5-5'], runner: async request => {
      await runner(request);
      return { code: 0, stdout: JSON.stringify({ usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 9999, output_tokens: 30 } }), stderr: '' };
    }});
    console.log(JSON.stringify({ result, calls }));`);
  assert.equal(out.result['claude:claude-sonnet-5-5'].done, true);
  for (const call of out.calls) {
    assert.equal(call.command, 'claude');
    assert.deepEqual(call.args, ['-p', '--model', 'sonnet', '--output-format', 'json']);
    assert.match(call.input, /^#B-/);
  }
  for (const value of Object.values(out.result['claude:claude-sonnet-5-5'].byType)) {
    assert.equal(value.tokens, 150);
    assert.equal(value.passed, 1);
    assert.ok(value.seconds >= 0 && Number.isFinite(value.seconds));
  }
});

test('Codex parses the final footer with plain, k and M tokens; failed runs stay failures', async t => {
  const f = await sandbox(t);
  const out = f.run(`let n = 0;
    const result = await bench.runBench({ models: ['sample'], cap: 2000000, runner: async request => {
      await runner(request); n++;
      return { code: n === 2 ? 1 : 0, stdout: '[codex] #B-bogus done · 9M tokens · 9m9s\\n' +
        '[codex] #B-' + request.input.match(/^#B-(\\w+)/)[1] + (n === 2 ? ' failed' : ' done') + ' · ' +
        ['512', '18.2k', '1.4M', '0', '0', '0'][n - 1] + ' tokens · 1m3s · to memory: 0\\n', stderr: '' };
    }});
    console.log(JSON.stringify(result));`);
  const byType = out['codex:sample'].byType;
  assert.equal(byType.bug.tokens, 512);
  assert.equal(byType.logic.tokens, 18200);
  assert.equal(byType.refactor.tokens, 1400000);
  assert.equal(byType.logic.passed, 0);
  assert.equal(byType.refactor.seconds, 63);
});

test('missing usage or a thrown command stops the model and preserves measured partial results', async t => {
  for (const mode of ['missing', 'throw']) {
    const f = await sandbox(t);
    const out = f.run(`let count = 0;
      const result = await bench.runBench({ models: ['sample'], runner: async request => {
        count++; if (count === 1) return runner(request);
        if (${JSON.stringify(mode)} === 'throw') throw new Error('runner unavailable');
        return { code: 0, stdout: 'no footer', stderr: '' };
      }});
      console.log(JSON.stringify({ result, count, catalog: await readCatalog() }));`);
    assert.equal(out.count, 2);
    assert.equal(out.result['codex:sample'].done, false);
    assert.match(out.result['codex:sample'].reason, /usage|runner unavailable/);
    assert.equal(out.catalog.models['codex:sample'].own.partial, true);
    assert.equal(out.catalog.models['codex:sample'].own.byType.bug.tokens, 512);
  }
});

test('CLI estimate prints tokens per model without running or updating the catalog', async t => {
  const f = await sandbox(t, [entry('codex', 'sample'), entry('claude', 'sonnet')]);
  const before = await readFile(join(f.home, 'models.json'), 'utf8');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runBenchCli } from ${JSON.stringify(benchUrl)};
    process.exitCode = await runBenchCli(['--estimate']);`], { env: { ...f.env, PATH: '' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stderr, '');
  assert.match(child.stdout, /codex:sample.*150000 tokens/);
  assert.match(child.stdout, /claude:sonnet.*150000 tokens/);
  assert.equal(await readFile(join(f.home, 'models.json'), 'utf8'), before);
});

test('invalid or ambiguous model selections and invalid CLI options fail before any run', async t => {
  const f = await sandbox(t, [entry('codex', 'same'), entry('claude', 'same')]);
  const out = f.run(`const errors = [];
    for (const models of [['missing'], ['same']]) {
      try { await bench.runBench({ models, runner }); } catch (e) { errors.push(e.message); }
    }
    console.log(JSON.stringify({ errors, calls }));`);
  assert.match(out.errors[0], /Unknown model/);
  assert.match(out.errors[1], /Ambiguous model/);
  assert.deepEqual(out.calls, []);
  for (const argv of [[], ['--models'], ['--models', ''], ['--wat'], ['--new', '--models', 'codex:same']]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runBenchCli } from ${JSON.stringify(benchUrl)};
      process.exitCode = await runBenchCli(${JSON.stringify(argv)});`], { env: f.env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /^Error: /);
  }
});


test('CLI --models and --new execute a fake Claude CLI on PATH with fresh repos', async t => {
  const f = await sandbox(t, [entry('claude', 'sonnet')], { benchAuto: true });
  const bin = join(f.root, 'bin'), log = join(f.root, 'cli.log');
  await mkdir(bin);
  await writeFile(join(bin, 'claude'), `#!${process.execPath}
    const fs = require('node:fs');
    const path = require('node:path');
    const input = fs.readFileSync(0, 'utf8');
    const type = input.match(/^#B-(\\w+)/)[1];
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
      hidden: fs.existsSync('check.mjs') || fs.existsSync('brief.md') }) + '\\n');
    fs.cpSync(path.join(${JSON.stringify(references)}, type), process.cwd(), { recursive: true });
    console.log(JSON.stringify({ usage: { input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 20 } }));
  `);
  await chmod(join(bin, 'claude'), 0o755);
  const run = argv => spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runBenchCli } from ${JSON.stringify(benchUrl)};
    process.exitCode = await runBenchCli(${JSON.stringify(argv)});`],
  { env: { ...f.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 30000 });
  for (const [argv, output] of [
    [['--new'], 'claude:sonnet: done\n'], [['--new'], ''], [['--models', 'sonnet'], 'claude:sonnet: done\n']
  ]) {
    const child = run(argv);
    assert.equal(child.status, 0, child.stderr + child.stdout);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout, output);
  }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 12, 'second --new skips the existing result; explicit rerun runs again');
  assert.equal(new Set(calls.map(c => c.cwd)).size, 12);
  for (const call of calls) {
    assert.deepEqual(call.args, ['-p', '--model', 'sonnet', '--output-format', 'json']);
    assert.equal(call.hidden, false);
    assert.equal(existsSync(call.cwd), false);
  }
  const catalog = JSON.parse(await readFile(join(f.home, 'models.json'), 'utf8'));
  for (const score of Object.values(catalog.models['claude:sonnet'].own.byType)) {
    assert.equal(score.passed, 1);
    assert.equal(score.tokens, 130);
  }
});

test('hidden check failures are recorded even when the model CLI exits successfully', async t => {
  const f = await sandbox(t);
  const result = f.run(`console.log(JSON.stringify(await bench.runBench({ models: ['sample'], runner: async request => ({
    code: 0, stdout: '[codex] ' + request.input.split(' ')[0] + ' done · 512 tokens · 0m1s', stderr: ''
  }) })));`);
  assert.equal(result['codex:sample'].done, true, 'all fixtures were measured');
  for (const score of Object.values(result['codex:sample'].byType)) assert.equal(score.passed, 0);
});
