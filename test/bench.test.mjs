import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const childDiagnostics = result => `signal=${result.signal}; stderr=${result.stderr ?? ''}`;

const plugin = fileURLToPath(new URL('../plugins/orchestra/', import.meta.url));
const benchUrl = new URL('../plugins/orchestra/lib/bench.mjs', import.meta.url).href;
const catalogUrl = new URL('../plugins/orchestra/lib/catalog.mjs', import.meta.url).href;
const references = fileURLToPath(new URL('fixtures/bench-ref/', import.meta.url));
const types = ['bug', 'logic', 'refactor', 'tests', 'docs', 'multi'];
const entry = (provider, model, extra = {}) => ({ id: `${provider}:${model}`, provider, model, available: { ok: true }, own: null, ...extra });

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
      ${body}`], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, childDiagnostics(child));
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
    const check = () => spawnSync(process.execPath, [join(fixture, 'check.mjs'), repo], { encoding: 'utf8', timeout: type === 'tests' ? 60000 : 30000 });
    const red = check();
    assert.notEqual(red.status, 0, 'untouched repo must fail');
    await cp(join(references, type), repo, { recursive: true });
    const green = check();
    assert.equal(green.status, 0, childDiagnostics(green) + green.stdout);
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
    assert.deepEqual(out.catalog.models[id].own.partial, { reason: 'token cap' });
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
  assert.deepEqual(Object.keys(own.byType), types.filter(type => type !== 'multi'));
  for (const type of types.filter(type => type !== 'multi')) {
    const n = type === 'refactor' ? 2 : 1;
    assert.deepEqual(own.byType[type], { passed: n, total: n, tokens: 512 * n, seconds: 2 * n });
  }
  for (const call of out.calls) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.timeout, 600000);
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
  assert.deepEqual(out.catalog.models['codex:new'].own.partial, { reason: 'board active' });
  const resumed = f.run(`import { rm } from 'node:fs/promises';
    await rm(${JSON.stringify(join(f.home, 'boards', 'new.json'))});
    const result = await bench.runBench({ auto: true, runner });
    console.log(JSON.stringify({ result, calls, catalog: await readCatalog() }));`);
  assert.equal(resumed.result['codex:new'].done, true);
  assert.deepEqual(resumed.calls.map(call => call.input.match(/^#B-(\w+)/)[1]), types.slice(1));
  assert.equal(resumed.catalog.models['codex:new'].own.byType.bug.total, 1);
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
    assert.deepEqual(call.args, ['-p', '--model', 'sonnet', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read Edit Write Glob Grep Bash(node:*)']);
    assert.match(call.input, /^#B-/);
    assert.equal(call.timeout, 600000);
  }
  for (const value of Object.values(out.result['claude:claude-sonnet-5-5'].byType)) {
    assert.equal(value.tokens, 150 * value.total);
    assert.equal(value.passed, value.total);
    assert.ok(value.seconds >= 0 && Number.isFinite(value.seconds));
  }
});

test('Codex parses the final footer with plain, k and M tokens and aggregates refactor samples', async t => {
  const f = await sandbox(t);
  const out = f.run(`let n = 0;
    const result = await bench.runBench({ models: ['sample'], cap: 2000000, runner: async request => {
      await runner(request); n++;
      return { code: 0, stdout: '[codex] #B-bogus done · 9M tokens · 9m9s\\n' +
        '[codex] #B-' + request.input.match(/^#B-(\\w+)/)[1] + ' done' + ' · ' +
        ['512', '18.2k', '1.4M', '1', '1', '1'][n - 1] + ' tokens · 1m3s · to memory: 0\\n', stderr: '' };
    }});
    console.log(JSON.stringify(result));`);
  const byType = out['codex:sample'].byType;
  assert.equal(byType.bug.tokens, 512);
  assert.equal(byType.logic.tokens, 18200);
  assert.equal(byType.refactor.tokens, 1400001);
  assert.equal(byType.logic.passed, 1);
  assert.equal(byType.refactor.seconds, 126);
  assert.equal(byType.refactor.total, 2);
  assert.equal(byType.multi, undefined);
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
    assert.match(out.catalog.models['codex:sample'].own.partial.reason, /^runner error: /);
    assert.equal(out.catalog.models['codex:sample'].own.byType.bug.tokens, 512);
  }
});

test('CLI estimate prints tokens per model without running or updating the catalog', async t => {
  const f = await sandbox(t, [entry('codex', 'sample'), entry('claude', 'sonnet')]);
  const before = await readFile(join(f.home, 'models.json'), 'utf8');
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runBenchCli } from ${JSON.stringify(benchUrl)};
    process.exitCode = await runBenchCli(['--estimate']);`], { env: { ...f.env, PATH: '' }, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, childDiagnostics(child));
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
  for (const argv of [[], ['--models'], ['--models', ''], ['--wat'], ['--new', '--models', 'codex:same'], ['--skip'], ['--skip', ''],
    ['--estimate', '--skip', 'codex:same'], ['--models', 'codex:same', '--skip', 'codex:same']]) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runBenchCli } from ${JSON.stringify(benchUrl)};
      process.exitCode = await runBenchCli(${JSON.stringify(argv)});`], { env: f.env, encoding: 'utf8', timeout: 30000 });
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
  { env: { ...f.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 60000 });
  for (const [argv, output] of [
    [['--new'], 'claude:sonnet: done\n'], [['--new'], ''], [['--models', 'sonnet'], 'claude:sonnet: done\n']
  ]) {
    const child = run(argv);
    assert.equal(child.status, 0, childDiagnostics(child) + child.stdout);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout, output);
  }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 12, 'second --new skips the existing result; explicit rerun runs again');
  assert.equal(new Set(calls.map(c => c.cwd)).size, 12);
  for (const call of calls) {
    assert.deepEqual(call.args, ['-p', '--model', 'sonnet', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read Edit Write Glob Grep Bash(node:*)']);
    assert.equal(call.hidden, false);
    assert.equal(existsSync(call.cwd), false);
  }
  const catalog = JSON.parse(await readFile(join(f.home, 'models.json'), 'utf8'));
  for (const score of Object.values(catalog.models['claude:sonnet'].own.byType)) {
    assert.equal(score.passed, score.total);
    assert.equal(score.tokens, 130 * score.total);
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

for (const [type, file, wrong] of [
  ['logic', 'slots.mjs', `export function available(slots, start, end) {
    if (end <= start) return [];
    return slots.filter(s => s.start < end && s.end > start).sort((a, b) => a.id.localeCompare(b.id));
  }`],
  ['multi', 'parse.mjs', `export function parseIds(text) {
    return [...new Set(text.split(',').map(s => parseInt(s, 10)).filter(n => Number.isSafeInteger(n) && n > 0))];
  }`],
  ['multi', 'report.mjs', `export function report(text) {
    const ids = [...new Set(text.split(',').map(s => s.trim()).filter(s => /^\\d+$/.test(s))
      .map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
    return { count: ids.length, ids };
  }`],
  ['docs', 'README.md', null]
]) {
  test(`fixture ${type} rejects review counterexample in ${file}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'orchestra-bad-fixture-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await cp(join(plugin, 'bench', type, 'repo'), root, { recursive: true });
    await cp(join(references, type), root, { recursive: true });
    const content = wrong ?? (await readFile(join(plugin, 'bench', type, 'brief.md'), 'utf8')) + '\n```js\n\n```\n';
    await writeFile(join(root, file), content);
    const child = spawnSync(process.execPath, [join(plugin, 'bench', type, 'check.mjs'), root], { encoding: 'utf8', timeout: 30000 });
    assert.notEqual(child.status, 0, child.stdout + child.stderr);
  });
}

test('unavailable, unknown-availability and unsupported models never run or get own written', async t => {
  const f = await sandbox(t, [entry('codex', 'offline', { available: { ok: false } }),
    entry('codex', 'unknown', { available: undefined }), entry('gemini', 'future')], { benchAuto: true });
  for (const options of ['{ auto: true, runner }', "{ models: ['offline', 'unknown', 'future'], runner }"]) {
    const out = f.run(`const result = await bench.runBench(${options});
      console.log(JSON.stringify({ result, calls, catalog: await readCatalog() }));`);
    assert.deepEqual(out.result, {});
    assert.deepEqual(out.calls, []);
    for (const model of Object.values(out.catalog.models)) assert.equal(model.own, null);
  }
});

test('runner failures stop immediately without scoring a model failure and auto retries missing fixtures', async t => {
  for (const [provider, response] of [
    ['codex', { code: 1, stdout: 'auth expired\n[codex] #B-logic failed · 0 tokens · 0m1s', stderr: '' }],
    ['codex', { code: 0, stdout: '[codex] #B-logic done · 0 tokens · 0m1s', stderr: '' }],
    ['codex', { code: 0, stdout: 'network unavailable\n[codex] #B-logic failed · 25 tokens · 0m1s', stderr: '' }],
    ['codex', { code: null, signal: 'SIGTERM', stdout: '', stderr: 'model command timed out' }],
    ['codex', { code: 1, stdout: '[codex] #B-logic done · 25 tokens · 0m1s', stderr: 'network unavailable' }],
    ['claude', { code: 0, stdout: JSON.stringify({ is_error: true, result: 'auth expired', usage: { input_tokens: 0, output_tokens: 0 } }) }],
    ['claude', { code: 0, stdout: JSON.stringify({ is_error: true, result: 'auth expired', usage: { input_tokens: 10, output_tokens: 2 } }) }],
    ['claude', { code: 1, stdout: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2 } }), stderr: 'unknown model' }],
    ['claude', { code: 0, stdout: JSON.stringify({ usage: { input_tokens: 0, output_tokens: 0 } }) }]
  ]) {
    const f = await sandbox(t, [entry(provider, 'sample')], { benchAuto: true });
    const good = provider === 'claude' ? `return { code: 0, stdout: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2 } }) };` : 'return answer;';
    const failed = f.run(`let n = 0;
      const result = await bench.runBench({ auto: true, runner: async request => {
        const answer = await runner(request); if (++n === 2) return ${JSON.stringify(response)};
        ${good}
      }});
      console.log(JSON.stringify({ result, calls, catalog: await readCatalog() }));`);
    const id = `${provider}:sample`, own = failed.catalog.models[id].own;
    assert.equal(failed.calls.length, 2);
    assert.equal(failed.result[id].done, false);
    assert.match(own.partial.reason, /^runner error: /);
    assert.equal(own.byType.bug.passed, 1);
    assert.equal(own.byType.logic, undefined);
    const resumed = f.run(`const result = await bench.runBench({ auto: true, runner: async request => {
      const answer = await runner(request); ${good}
    }}); console.log(JSON.stringify({ result, calls, catalog: await readCatalog() }));`);
    assert.deepEqual(resumed.calls.map(c => c.input.match(/^#B-(\w+)/)[1]), types.slice(1));
    assert.equal(resumed.result[id].done, true);
    assert.equal(resumed.catalog.models[id].own.partial, false);
    assert.equal(resumed.result[id].byType.refactor.total, 2);
  }
});

test('auto resumes a legacy postponed partial, preserving the completed refactor sample', async t => {
  const byType = Object.fromEntries(types.filter(type => type !== 'multi').map(type => [type,
    { passed: 1, total: 1, tokens: 10, seconds: 1 }]));
  const f = await sandbox(t, [entry('codex', 'sample', { own: { partial: true, reason: 'low limit', byType } })], { benchAuto: true });
  const out = f.run(`const result = await bench.runBench({ auto: true, runner });
    console.log(JSON.stringify({ result, calls, catalog: await readCatalog() }));`);
  assert.deepEqual(out.calls.map(c => c.input.match(/^#B-(\w+)/)[1]), ['multi']);
  assert.equal(out.result['codex:sample'].done, true);
  assert.deepEqual(out.result['codex:sample'].byType.refactor, { passed: 2, total: 2, tokens: 522, seconds: 3 });
});

test('over-cap runs are marked and token-capped partials are not automatically retried', async t => {
  const f = await sandbox(t, undefined, { benchAuto: true });
  const out = f.run(`const result = await bench.runBench({ auto: true, runner: async request => {
    const answer = await runner(request); return { ...answer, stdout: answer.stdout.replace('512', '150.1k') };
  }}); console.log(JSON.stringify({ result, calls, catalog: await readCatalog() }));`);
  assert.equal(out.calls.length, 1);
  assert.deepEqual(out.catalog.models['codex:sample'].own.partial, { reason: 'token cap' });
  assert.equal(out.catalog.models['codex:sample'].own.overCap, true);
  const retry = f.run(`const result = await bench.runBench({ auto: true, runner }); console.log(JSON.stringify({ result, calls }));`);
  assert.deepEqual(retry, { result: {}, calls: [] });
});

test('CLI --skip records not-picked entries and --new never runs them', async t => {
  const f = await sandbox(t, [entry('codex', 'a'), entry('claude', 'b')], { benchAuto: true });
  const out = f.run(`const code = await bench.runBenchCli(['--skip', 'a,claude:b']);
    const result = await bench.runBench({ auto: true, runner });
    console.log(JSON.stringify({ code, result, calls, catalog: await readCatalog() }));`);
  assert.equal(out.code, 0);
  assert.deepEqual(out.calls, []);
  assert.deepEqual(out.result, {});
  for (const model of Object.values(out.catalog.models)) {
    assert.equal(model.own.skipped, 'not picked');
    assert.match(model.own.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(Object.keys(model.own).sort(), ['date', 'skipped']);
  }
});

test('CLI --skip preserves benchmark results and reports kept entries with clean output', async t => {
  const byType = { bug: { passed: 1, total: 1, tokens: 512, seconds: 2 } };
  const measured = { date: '2026-10-01', partial: false, byType };
  const partial = { date: '2026-10-02', partial: { reason: 'token cap' }, byType };
  const f = await sandbox(t, [entry('codex', 'done', { own: measured }), entry('claude', 'partial', { own: partial }),
    entry('codex', 'new'), entry('codex', 'skipped', { own: { skipped: 'old reason', date: '2026-01-01' } })]);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runBenchCli } from ${JSON.stringify(benchUrl)};
    process.exitCode = await runBenchCli(['--skip', 'done,partial,new,skipped']);
  `], { env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, childDiagnostics(child)); assert.equal(child.stderr, '');
  assert.equal(child.stdout, 'codex:done: kept (already benchmarked)\nclaude:partial: kept (already benchmarked)\ncodex:new: skipped (not picked)\ncodex:skipped: skipped (not picked)\n');
  const catalog = JSON.parse(await readFile(join(f.home, 'models.json'), 'utf8'));
  assert.deepEqual(catalog.models['codex:done'].own, measured);
  assert.deepEqual(catalog.models['claude:partial'].own, partial);
  for (const id of ['codex:new', 'codex:skipped']) {
    assert.deepEqual(catalog.models[id].own, { skipped: 'not picked', date: new Date().toISOString().slice(0, 10) });
  }
});

test('a concurrent benchmark process exits zero and reports the owning pid', async t => {
  const f = await sandbox(t);
  const first = spawn(process.execPath, ['--input-type=module', '-e', `
    import { runBench } from ${JSON.stringify(benchUrl)};
    await runBench({ models: ['sample'], cap: 1, runner: async request => {
      console.log('ready'); await new Promise(resolve => process.stdin.once('data', resolve));
      return { code: 0, stdout: '[codex] #B-bug done · 1 tokens · 0m1s' };
    }});
  `], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (first.exitCode === null) first.kill('SIGKILL'); });
  const exited = new Promise(resolve => first.once('exit', resolve));
  await new Promise((resolve, reject) => {
    first.stdout.once('data', resolve); first.once('error', reject);
    first.once('exit', code => reject(new Error(`first runner exited ${code}`)));
  });
  try {
    const second = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runBenchCli } from ${JSON.stringify(benchUrl)};
      process.exitCode = await runBenchCli(['--models', 'sample']);`], { env: f.env, encoding: 'utf8', timeout: 30000 });
    assert.equal(second.status, 0, childDiagnostics(second));
    assert.equal(second.stdout, `bench already running (pid ${first.pid})\n`);
    assert.equal(second.stderr, '');
    const lock = JSON.parse(await readFile(join(f.home, 'bench.lock'), 'utf8'));
    assert.equal(lock.pid, first.pid);
    assert.ok(Number.isFinite(Date.parse(lock.startedAt)));
  } finally { first.stdin.end('continue'); await exited; }
  assert.equal(existsSync(join(f.home, 'bench.lock')), false);
});

test('dead-pid benchmark locks are reclaimed; replacement locks survive finally', async t => {
  const f = await sandbox(t);
  const dead = spawnSync(process.execPath, ['-e', ''], { env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(dead.status, 0, childDiagnostics(dead));
  const lock = join(f.home, 'bench.lock');
  await writeFile(lock, JSON.stringify({ pid: dead.pid, startedAt: '2020-01-01T00:00:00Z' }));
  f.run(`await bench.runBench({ models: ['sample'], cap: 1, runner }); console.log('null');`);
  assert.equal(existsSync(lock), false);
  f.run(`import { writeFile } from 'node:fs/promises';
    await bench.runBench({ models: ['sample'], cap: 1, runner: async request => {
      await writeFile(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, startedAt: 'replacement' }));
      return runner(request);
    }}); console.log('null');`);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).startedAt, 'replacement');
});

test('failed-run usage counts toward the resumed budget without adding a scored sample', async t => {
  const f = await sandbox(t, undefined, { benchAuto: true });
  const first = f.run(`await bench.runBench({ auto: true, runner: async () => ({
    code: 1, stdout: 'network unavailable\\n[codex] #B-bug failed · 150.1k tokens · 0m1s'
  }) }); console.log(JSON.stringify(await readCatalog()));`);
  assert.equal(first.models['codex:sample'].own.runnerTokens, 150100);
  assert.equal(first.models['codex:sample'].own.overCap, true);
  assert.deepEqual(first.models['codex:sample'].own.byType, {});
  const retry = f.run(`const result = await bench.runBench({ auto: true, runner });
    console.log(JSON.stringify({ result, calls, catalog: await readCatalog() }));`);
  assert.deepEqual(retry.calls, []);
  assert.deepEqual(retry.catalog.models['codex:sample'].own.partial, { reason: 'token cap' });
});

test('auto resumes after a limit postponement without repeating the first fixture', async t => {
  const f = await sandbox(t, [entry('claude', 'sonnet')], { benchAuto: true });
  const failure = f.run(`import { writeFile } from 'node:fs/promises';
    const result = await bench.runBench({ auto: true, runner: async request => {
      await runner(request);
      await writeFile(${JSON.stringify(join(f.home, 'limits.json'))}, JSON.stringify({ claude: { five_hour: { used_percent: 90 } } }));
      return { code: 0, stdout: JSON.stringify({ usage: { input_tokens: 20, output_tokens: 10 } }) };
    }}); console.log(JSON.stringify({ result, calls, catalog: await readCatalog() }));`);
  assert.equal(failure.calls.length, 1);
  assert.deepEqual(failure.catalog.models['claude:sonnet'].own.partial, { reason: 'low limit' });
  await writeFile(join(f.home, 'limits.json'), '{}');
  const resumed = f.run(`const result = await bench.runBench({ auto: true, runner: async request => {
    await runner(request); return { code: 0, stdout: JSON.stringify({ usage: { input_tokens: 20, output_tokens: 10 } }) };
  }}); console.log(JSON.stringify({ result, calls }));`);
  assert.deepEqual(resumed.calls.map(c => c.input.match(/^#B-(\w+)/)[1]), types.slice(1));
  assert.equal(resumed.result['claude:sonnet'].done, true);
});

test('skip and --new can be applied together without launching skipped models', async t => {
  const f = await sandbox(t, [entry('codex', 'a'), entry('claude', 'b')], { benchAuto: true });
  const out = f.run(`const code = await bench.runBenchCli(['--new', '--skip', 'a,b']);
    console.log(JSON.stringify({ code, catalog: await readCatalog() }));`);
  assert.equal(out.code, 0);
  for (const model of Object.values(out.catalog.models)) assert.equal(model.own.skipped, 'not picked');
  assert.equal(existsSync(join(f.home, 'bench.lock')), false);
});

test('CLI --skip replaces an empty runner-error partial and --new no longer runs it', async t => {
  const f = await sandbox(t, [entry('claude', 'sonnet', { own: {
    date: '2026-10-01', partial: { reason: 'runner error: Not logged in' }, byType: {}, completed: []
  } })], { benchAuto: true });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runBenchCli } from ${JSON.stringify(benchUrl)};
    process.exitCode = await runBenchCli(['--skip', 'sonnet']);
    if (!process.exitCode) process.exitCode = await runBenchCli(['--new']);
  `], { env: f.env, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, `signal=${child.signal}; stderr=${child.stderr}`);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout, 'claude:sonnet: skipped (not picked)\n');
  const catalog = JSON.parse(await readFile(join(f.home, 'models.json'), 'utf8'));
  assert.deepEqual(catalog.models['claude:sonnet'].own, { skipped: 'not picked', date: new Date().toISOString().slice(0, 10) });
});

for (const mode of ['timeout', 'signal']) {
  test(`a check killed by ${mode} is a runner error without a scored model failure`, async t => {
    const f = await sandbox(t);
    const out = f.run(`import { writeFile } from 'node:fs/promises';
      const result = await bench.runBench({ models: ['sample'], runner: async request => {
        await writeFile(join(request.cwd, 'basket.mjs'), ${JSON.stringify(mode === 'timeout'
          ? "await new Promise(resolve => setTimeout(resolve, 60000));"
          : "process.kill(process.pid, 'SIGTERM'); await new Promise(resolve => setTimeout(resolve, 60000));")});
        return { code: 0, stdout: '[codex] ' + request.input.split(' ')[0] + ' done · 512 tokens · 0m1s', stderr: '' };
      }});
      console.log(JSON.stringify({ result, catalog: await readCatalog() }));`);
    assert.equal(out.result['codex:sample'].done, false);
    assert.equal(out.result['codex:sample'].reason, 'runner error: check timed out');
    assert.deepEqual(out.catalog.models['codex:sample'].own.byType, {});
    assert.deepEqual(out.catalog.models['codex:sample'].own.completed, []);
    assert.equal(out.catalog.models['codex:sample'].own.runnerTokens, 512);
  });
}

test('bench exits quickly with runner errors when PATH is empty or Claude is missing', async t => {
  const f = await sandbox(t, [entry('claude', 'sonnet')]);
  // Only git is available in this bin: the prerequisite succeeds, the provider emits ENOENT.
  const bin = join(f.root, 'git-only'); await mkdir(bin);
  await writeFile(join(bin, 'git'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  for (const path of ['', bin]) {
    const started = performance.now();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { runBench } from ${JSON.stringify(benchUrl)};
      console.log(JSON.stringify(await runBench({ models: ['sonnet'] })));
    `], { env: { ...f.env, PATH: path }, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, `signal=${child.signal}; stderr=${child.stderr}`);
    assert.equal(child.stderr, '');
    assert(performance.now() - started < 10000, 'missing executables must finish well under ten seconds');
    const result = JSON.parse(child.stdout)['claude:sonnet'];
    assert.match(result.reason, /^runner error: .*ENOENT/);
    assert.deepEqual(result.byType, {});
  }
});
