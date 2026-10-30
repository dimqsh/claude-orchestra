import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const plugin = fileURLToPath(new URL('../plugins/orchestra/', import.meta.url));
const discoverUrl = pathToFileURL(join(plugin, 'lib/discover.mjs')).href;
const catalogUrl = pathToFileURL(join(plugin, 'lib/catalog.mjs')).href;
const cli = join(plugin, 'scripts/models.mjs');

function setup(t, { oauth = true, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-discover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), store = join(root, 'orchestra'), claude = join(root, 'claude'), bin = join(root, 'bin');
  for (const dir of [home, store, claude, bin]) mkdirSync(dir);
  for (const [name, fixture] of [['codex', 'codex-models'], ['gemini', 'gemini-probe'], ['claude', 'codex-models'], ['kimi', 'codex-models']]) {
    const dest = join(bin, name);
    copyFileSync(new URL(`fixtures/bin/${fixture}`, import.meta.url), dest);
    chmodSync(dest, 0o755);
  }
  if (oauth) { mkdirSync(join(home, '.gemini')); writeFileSync(join(home, '.gemini/oauth_creds.json'), '{}'); }
  const log = join(root, 'calls.jsonl');
  const childEnv = { ...process.env, HOME: home, ORCHESTRA_HOME: store, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: join(root, 'codex'),
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, DISCOVERY_LOG: log,
    CODEX_LIST_ERROR: '', CODEX_PROBE_ERROR: '', CODEX_MODELS: '', GEMINI_PROBE_ERROR: '', ...env };
  const run = (body, options = {}) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    `import * as d from ${JSON.stringify(discoverUrl)}; import * as c from ${JSON.stringify(catalogUrl)}; ${body}`],
  { env: childEnv, encoding: 'utf8', ...options }).trim());
  return { root, store, claude, bin, env: childEnv, run,
    calls: () => { try { return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } },
    seed: value => writeFileSync(join(store, 'models.json'), JSON.stringify({ version: 1, models: {}, ...value })),
  };
}

test('codex models come from codex debug models, visible ones only', t => {
  const f = setup(t);
  const out = f.run('console.log(JSON.stringify(await d.listCodex()));');
  assert.deepEqual(out, [{ provider: 'codex', model: 'gpt-6.1-sol', runner: 'codex-task.mjs', efforts: ['low', 'high'], description: 'Codex hand' }]);
  assert.deepEqual(f.calls()[0].args, ['debug', 'models']);
  const stored = f.run('await d.discover(); console.log(JSON.stringify(await c.readCatalog()));');
  assert.deepEqual(Object.keys(stored.models).filter(id => id.startsWith('codex:')), ['codex:gpt-6.1-sol']);
  assert.equal(stored.models['codex:gpt-6.1-sol'].available.ok, true);
});

test('codex debug models accepts listings larger than 1 MB', t => {
  const f = setup(t);
  writeFileSync(join(f.bin, 'codex'), `#!${process.execPath}
    console.log(JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', description: 'x'.repeat(2 * 1024 * 1024) }] }));
  `);
  const out = f.run('const models = await d.listCodex().catch(error => { console.error(error.message); process.exit(1); }); console.log(JSON.stringify(models.map(({ model, description }) => ({ model, length: description.length }))));');
  assert.deepEqual(out, [{ model: 'gpt-6.1-sol', length: 2 * 1024 * 1024 }]);
});

test('claude hands are haiku and sonnet; fable only with allowFable; opus never', t => {
  const f = setup(t);
  assert.deepEqual(f.run('console.log(JSON.stringify((await d.listClaude()).map(x => x.model)));'), ['haiku', 'sonnet']);
  writeFileSync(join(f.store, 'config.json'), JSON.stringify({ allowFable: true }));
  assert.deepEqual(f.run('console.log(JSON.stringify((await d.listClaude()).map(x => x.model)));'), ['haiku', 'sonnet', 'fable']);
  f.run('await d.discover(); console.log(JSON.stringify(await c.readCatalog()));');
  assert.equal(f.calls().some(x => x.command === 'claude'), false);
});

test('Claude resolves the latest concrete model per alias from recent main and subagent transcripts', t => {
  const f = setup(t);
  const dir = join(f.claude, 'projects/project/session/subagents'); mkdirSync(dir, { recursive: true });
  const row = (model, timestamp) => JSON.stringify({ type: 'assistant', timestamp, message: { model } });
  writeFileSync(join(f.claude, 'projects/project/main.jsonl'), [
    row('claude-sonnet-5-4', '2026-10-27T10:00:00Z'), row('claude-sonnet-5-5', '2026-10-28T10:00:00Z'),
    row('claude-sonnet-5-3', '2026-10-26T10:00:00Z'), row('claude-opus-5-5', '2026-10-29T10:00:00Z'),
    JSON.stringify({ type: 'user', message: { model: 'claude-sonnet-99' } }), '{torn',
  ].join('\n'));
  writeFileSync(join(dir, 'agent-a.jsonl'), row('claude-haiku-5-5', '2026-10-28T12:00:00Z'));
  const stale = join(dir, 'agent-old.jsonl'); writeFileSync(stale, row('claude-sonnet-99', '2099-01-01T00:00:00Z'));
  const old = new Date(Date.now() - 8 * 86400000); utimesSync(stale, old, old);
  const out = f.run('await d.discover(); console.log(JSON.stringify((await c.readCatalog()).models));');
  assert.equal(out['claude:sonnet'].resolved, 'claude-sonnet-5-5');
  assert.equal(out['claude:haiku'].resolved, 'claude-haiku-5-5');
  assert.equal(out['claude:opus'], undefined);
});

test('gemini is skipped without ~/.gemini/oauth_creds.json', t => {
  const f = setup(t, { oauth: false });
  const out = f.run('await d.discover(); console.log(JSON.stringify(await c.readCatalog()));');
  assert.equal(f.calls().some(x => x.command === 'gemini'), false);
  assert.equal(out.models['gemini:default'].available.ok, false);
  assert.match(out.models['gemini:default'].available.error, /oauth_creds.json/);
});

test('Gemini includes the CLI default plus up to three newest Google models with public data', t => {
  const f = setup(t);
  const models = Object.fromEntries([
    ['gemini-2.5-pro', '2026-01-01'], ['gemini-3-pro', '2026-05-01'], ['gemini-3-flash', '2026-06-01'], ['gemini-3.1-pro', '2026-07-01'],
  ].map(([model, date]) => [`gemini:${model}`, { provider: 'gemini', model, public: { source: 'artificialanalysis.ai', date } }]));
  models['codex:gpt-6.1-sol'] = { provider: 'codex', model: 'gpt-6.1-sol', public: { source: 'artificialanalysis.ai', date: '2026-08-01' } };
  models['gemini:unverified'] = { provider: 'gemini', model: 'unverified', public: { source: null, note: 'no public data' } };
  f.seed({ models });
  assert.deepEqual(f.run('console.log(JSON.stringify(d.listGemini(await c.readCatalog()).map(x => x.model)));'),
    ['default', 'gemini-3.1-pro', 'gemini-3-flash', 'gemini-3-pro']);
  const empty = f.run('console.log(JSON.stringify(d.listGemini({ models: {} })));');
  assert.equal(empty.length, 1); assert.equal(empty[0].model, 'default');
});

test('Gemini default probe omits -m and named model uses it', t => {
  const f = setup(t);
  assert.deepEqual(f.run(`console.log(JSON.stringify(await d.probe({ provider: 'gemini', model: 'default' })));`), { ok: true });
  assert.deepEqual(f.run(`console.log(JSON.stringify(await d.probe({ provider: 'gemini', model: 'gemini-3-pro' })));`), { ok: true });
  assert.deepEqual(f.calls().filter(x => x.stage === 'start').map(x => x.args), [['-p', 'Reply OK'], ['-m', 'gemini-3-pro', '-p', 'Reply OK']]);
});

test('kimi is listed as disabled: no sandbox and never probed', t => {
  const f = setup(t);
  const out = f.run('const result = await d.discover(); console.log(JSON.stringify({ result, models: (await c.readCatalog()).models, candidates: d.listKimi() }));');
  assert.equal(out.candidates.length, 1);
  const kimi = Object.values(out.models).filter(x => x.provider === 'kimi');
  assert.equal(kimi.length, 1); assert.equal(kimi[0].available.ok, false);
  assert.equal(kimi[0].available.error, 'disabled: no sandbox');
  assert.ok(out.result.unavailable.includes(kimi[0].id));
  assert.equal(f.calls().some(x => x.command === 'kimi'), false);
});

for (const error of ['auth expired', 'IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals']) {
  test(`a failed probe keeps the model as unavailable with the error text: ${error}`, t => {
    const f = setup(t, { env: { GEMINI_PROBE_ERROR: error } });
    const out = f.run('const result = await d.discover(); console.log(JSON.stringify({ result, model: (await c.readCatalog()).models["gemini:default"] }));');
    assert.equal(out.model.available.ok, false); assert.equal(out.model.available.error, error);
    assert.ok(out.result.unavailable.includes('gemini:default'));
    assert.ok(Number.isFinite(Date.parse(out.model.available.checkedAt)));
  });
}

test('discovery runs at most once per 24 h unless --force', t => {
  const f = setup(t);
  f.run('await d.discover(); console.log(JSON.stringify(await c.readCatalog()));');
  const count = f.calls().length;
  assert.deepEqual(f.run('console.log(JSON.stringify(await d.discover()));'), { added: [], changed: [], unavailable: [] });
  assert.equal(f.calls().length, count);
  const forced = spawnSync(process.execPath, [cli, 'discover', '--force'], { env: f.env, encoding: 'utf8' });
  assert.equal(forced.status, 0, forced.stderr); assert.equal(forced.stderr, '');
  assert.match(forced.stdout, /^added: .*\nunavailable: .*\n$/);
  assert.ok(f.calls().length > count);
  f.run('await c.updateCatalog(x => { x.discoveredAt = new Date(Date.now() - 25 * 3600000).toISOString(); }); console.log("{}");');
  const before = f.calls().length;
  f.run('await d.discover(); console.log("{}");');
  assert.ok(f.calls().length > before);
});

test('probes run one at a time', t => {
  const f = setup(t);
  f.seed({ models: { 'gemini:gemini-3-pro': { provider: 'gemini', model: 'gemini-3-pro', public: { source: 'fixture', date: '2026-10-28' } } } });
  f.run('await d.discover(); console.log("{}");');
  const calls = f.calls().filter(x => x.stage !== 'stdin-eof'); assert.ok(calls.length >= 8);
  for (let i = 0; i < calls.length; i += 2) {
    assert.equal(calls[i].stage, 'start'); assert.equal(calls[i + 1].stage, 'end');
    assert.deepEqual(calls[i].args, calls[i + 1].args);
    if (i > 0) assert.ok(calls[i].time >= calls[i - 1].time);
  }
});

test('unchanged Codex models are not re-probed; changed efforts are re-probed and fields survive', t => {
  const f = setup(t);
  f.run('await d.discover(); await c.updateCatalog(x => { Object.assign(x.models["codex:gpt-6.1-sol"], { public: { source: "fixture", codingIndex: 61.2 }, own: { byType: {} }, notes: "keep", access: "subscription" }); }); console.log("{}");');
  const out = f.run('const result = await d.discover({ force: true }); console.log(JSON.stringify({ result, model: (await c.readCatalog()).models["codex:gpt-6.1-sol"] }));');
  assert.equal(f.calls().filter(x => x.stage === 'start' && x.args[0] === 'exec').length, 1);
  assert.deepEqual(out.model.public, { source: 'fixture', codingIndex: 61.2 });
  assert.deepEqual(out.model.own, { byType: {} }); assert.equal(out.model.notes, 'keep'); assert.equal(out.model.access, 'subscription');
  assert.deepEqual(out.result.changed, []);
  f.env.CODEX_MODELS = JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'xhigh' }] }] });
  const changed = f.run('console.log(JSON.stringify(await d.discover({ force: true })));');
  assert.ok(changed.changed.includes('codex:gpt-6.1-sol'));
  assert.equal(f.calls().filter(x => x.stage === 'start' && x.args[0] === 'exec').length, 2);
  const again = f.run('console.log(JSON.stringify(await d.discover({ force: true })));');
  assert.deepEqual(again.changed, []);
  assert.equal(f.calls().filter(x => x.stage === 'start' && x.args[0] === 'exec').length, 2);
});

test('failed Codex probes retry after 24 hours and retain the failure until then', t => {
  const f = setup(t, { env: { CODEX_PROBE_ERROR: 'login required' } });
  const first = f.run('await d.discover(); console.log(JSON.stringify((await c.readCatalog()).models["codex:gpt-6.1-sol"]));');
  assert.equal(first.available.ok, false); assert.equal(first.available.error, 'login required');
  f.env.CODEX_PROBE_ERROR = '';
  f.run('await c.updateCatalog(x => { x.discoveredAt = new Date(Date.now() - 25 * 3600000).toISOString(); x.models["codex:gpt-6.1-sol"].available.checkedAt = x.discoveredAt; }); console.log("{}");');
  const out = f.run('const result = await d.discover(); console.log(JSON.stringify({ result, model: (await c.readCatalog()).models["codex:gpt-6.1-sol"] }));');
  assert.equal(out.model.available.ok, true); assert.equal(out.model.available.error, undefined);
  assert.ok(out.result.changed.includes('codex:gpt-6.1-sol'));
});

test('Codex listing failures mark known models unavailable without losing benchmark fields', t => {
  const f = setup(t, { env: { CODEX_LIST_ERROR: 'codex logged out' } });
  f.seed({ models: { 'codex:known': { id: 'codex:known', provider: 'codex', model: 'known', public: { source: 'fixture' } } } });
  const out = f.run('const result = await d.discover(); console.log(JSON.stringify({ result, model: (await c.readCatalog()).models["codex:known"] }));');
  assert.equal(out.model.available.ok, false); assert.equal(out.model.available.error, 'codex logged out');
  assert.deepEqual(out.model.public, { source: 'fixture' });
  assert.ok(out.result.unavailable.includes('codex:known'));
});

test('runner injection uses the execFile callback contract for listing and probes', t => {
  const f = setup(t);
  const out = f.run(`
    const calls = [];
    const runner = (file, args, options, callback) => {
      calls.push([file, args]);
      callback(null, file === 'codex' && args[0] === 'debug' ? JSON.stringify({ models: [{ slug: 'injected', visibility: 'list', supported_reasoning_levels: [] }] }) : 'OK', '');
    };
    const result = await d.discover({ runner }); console.log(JSON.stringify({ result, calls }));`);
  assert.ok(out.result.added.includes('codex:injected'));
  assert.deepEqual(out.calls.map(x => x[0]), ['codex', 'codex', 'gemini']);
  assert.equal(f.calls().length, 0);
});

test('removed Codex models and an opted-out Fable cannot retain stale availability', t => {
  const f = setup(t);
  f.seed({ models: {
    'codex:gpt-reserve': { id: 'codex:gpt-reserve', provider: 'codex', model: 'gpt-reserve', available: { ok: true } },
    'claude:fable': { id: 'claude:fable', provider: 'claude', model: 'fable', available: { ok: true } },
  } });
  const out = f.run('const result = await d.discover(); console.log(JSON.stringify({ result, models: (await c.readCatalog()).models }));');
  for (const id of ['codex:gpt-reserve', 'claude:fable']) {
    assert.equal(out.models[id].available.ok, false);
    assert.ok(out.result.unavailable.includes(id)); assert.ok(out.result.changed.includes(id));
  }
  assert.equal(f.calls().some(x => x.args.includes('gpt-reserve')), false);
});

test('missing Codex and Gemini executables are recorded as unavailable', t => {
  const f = setup(t);
  rmSync(join(f.bin, 'codex')); rmSync(join(f.bin, 'gemini'));
  // Restrict PATH to the fixture directory, so no installed provider can be used.
  f.env.PATH = f.bin;
  f.seed({ models: { 'codex:known': { id: 'codex:known', provider: 'codex', model: 'known' } } });
  const out = f.run('await d.discover(); console.log(JSON.stringify((await c.readCatalog()).models));');
  for (const id of ['codex:known', 'gemini:default']) {
    assert.equal(out[id].available.ok, false); assert.match(out[id].available.error, /ENOENT/);
  }
  assert.equal(f.calls().length, 0);
});

test('discovery preserves benchmark updates made while probes are running', t => {
  const f = setup(t);
  const out = f.run(`
    const runner = (file, args, options, callback) => {
      if (args[0] === 'debug') callback(null, JSON.stringify({ models: [{ slug: 'concurrent', visibility: 'list', supported_reasoning_levels: [] }] }), '');
      else c.updateCatalog(x => { x.models['codex:concurrent'] = { ...x.models['codex:concurrent'], public: { source: 'concurrent', codingIndex: 99 }, own: { byType: {} } }; })
        .then(() => callback(null, 'OK', ''), callback);
    };
    await d.discover({ runner }); console.log(JSON.stringify((await c.readCatalog()).models['codex:concurrent']));`);
  assert.deepEqual(out.public, { source: 'concurrent', codingIndex: 99 });
  assert.deepEqual(out.own, { byType: {} }); assert.equal(out.available.ok, true);
});

test('models dispatcher rejects unknown commands and options with a single English error', t => {
  const f = setup(t);
  for (const args of [[], ['unknown'], ['discover', '--unknown']]) {
    const out = spawnSync(process.execPath, [cli, ...args], { env: f.env, encoding: 'utf8' });
    assert.equal(out.status, 1); assert.equal(out.stdout, '');
    assert.match(out.stderr, /^Error: Usage: models.mjs [^\n]+\n$/);
  }
  assert.equal(f.calls().length, 0);
});

test('models bench runs the benchmark CLI in a child process and returns its exit code', t => {
  const f = setup(t);
  f.seed({ models: { 'codex:sample': { id: 'codex:sample', provider: 'codex', model: 'sample', available: { ok: true }, own: null } } });
  const estimate = spawnSync(process.execPath, [cli, 'bench', '--estimate'], { env: f.env, encoding: 'utf8' });
  assert.equal(estimate.status, 0, estimate.stderr);
  assert.equal(estimate.stdout, 'codex:sample: 150000 tokens per model (budget estimate)\n');
  assert.equal(estimate.stderr, '');
  const bare = spawnSync(process.execPath, [cli, 'bench'], { env: f.env, encoding: 'utf8' });
  assert.equal(bare.status, 1); assert.equal(bare.stdout, '');
  assert.equal(bare.stderr, 'Error: Usage: bench --models a,b | --new | --estimate | --skip a,b\n');
  assert.equal(f.calls().length, 0);
});

test('Codex probes end stdin so the CLI can reach stdin EOF', t => {
  const f = setup(t);
  const out = f.run(`
    import { execFile } from 'node:child_process';
    // Keep a regression bounded: without EOF the actual fake blocks until this timeout. It is generous
    // because starting the fake node script can take several seconds on a busy machine.
    const runner = (file, args, options, callback) => execFile(file, args, { ...options, timeout: 15000 }, callback);
    console.log(JSON.stringify(await d.probe({ provider: 'codex', model: 'gpt-6.1-sol' }, { runner })));`);
  assert.ok(f.calls().some(x => x.stage === 'stdin-eof'), 'fake Codex must read stdin to EOF');
  assert.equal(out.ok, true, out.error);
});

test('Codex probes skip the git trust check in a directory outside a repository', t => {
  const f = setup(t);
  const out = f.run(`console.log(JSON.stringify(await d.probe({ provider: 'codex', model: 'gpt-6.1-sol' })));`, { cwd: f.root });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(f.calls().find(x => x.stage === 'start').args,
    ['exec', '-m', 'gpt-6.1-sol', '-s', 'read-only', '--skip-git-repo-check', 'Reply OK']);
});

for (const error of ['', 'auth expired']) {
  test(`Gemini probes run once per day even with --force: ${error || 'success'}`, t => {
    const f = setup(t, { env: { GEMINI_PROBE_ERROR: error } });
    f.seed({ models: { 'gemini:gemini-3-pro': { provider: 'gemini', model: 'gemini-3-pro', public: { source: 'fixture', date: '2026-10-28' } } } });
    const initial = f.run('await d.discover(); console.log(JSON.stringify((await c.readCatalog()).models["gemini:default"].available));');
    const starts = () => f.calls().filter(x => x.command === 'gemini' && x.stage === 'start');
    assert.equal(starts().length, 2);
    const forced = spawnSync(process.execPath, [cli, 'discover', '--force'], { env: f.env, encoding: 'utf8' });
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(starts().length, 2, 'default and named models each keep their daily probe budget');
    const cached = f.run('console.log(JSON.stringify((await c.readCatalog()).models["gemini:default"].available));');
    assert.deepEqual(cached, initial, 'reuse must preserve checkedAt as well as the result');
    f.env.GEMINI_PROBE_ERROR = '';
    f.run(`await c.updateCatalog(x => {
      x.discoveredAt = new Date(Date.now() - 25 * 3600000).toISOString();
      for (const model of Object.values(x.models)) if (model.provider === 'gemini') model.available.checkedAt = x.discoveredAt;
    }); console.log("{}");`);
    const refreshed = f.run('await d.discover(); console.log(JSON.stringify((await c.readCatalog()).models["gemini:default"].available));');
    assert.equal(starts().length, 4); assert.equal(refreshed.ok, true);
  });
}

for (const failure of ['listing', 'not listed', 'missing executable']) {
  test(`Codex non-probe failure does not prevent a forced probe after recovery: ${failure}`, t => {
    const f = setup(t);
    const originalPath = f.env.PATH;
    f.run('await d.discover(); console.log("{}");');
    if (failure === 'listing') f.env.CODEX_LIST_ERROR = 'codex logged out';
    if (failure === 'not listed') f.env.CODEX_MODELS = JSON.stringify({ models: [] });
    if (failure === 'missing executable') { rmSync(join(f.bin, 'codex')); f.env.PATH = f.bin; }
    const failed = f.run('await d.discover({ force: true }); console.log(JSON.stringify((await c.readCatalog()).models["codex:gpt-6.1-sol"].available));');
    assert.equal(failed.ok, false);
    if (failure === 'listing') assert.equal(failed.error, 'codex logged out');
    if (failure === 'not listed') assert.equal(failed.error, 'not listed by codex debug models');
    if (failure === 'missing executable') assert.match(failed.error, /ENOENT/);
    f.env.CODEX_LIST_ERROR = ''; f.env.CODEX_MODELS = ''; f.env.PATH = originalPath;
    if (failure === 'missing executable') {
      copyFileSync(new URL('fixtures/bin/codex-models', import.meta.url), join(f.bin, 'codex'));
      chmodSync(join(f.bin, 'codex'), 0o755);
    }
    const recovered = f.run('await d.discover({ force: true }); console.log(JSON.stringify((await c.readCatalog()).models["codex:gpt-6.1-sol"].available));');
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(f.calls().filter(x => x.stage === 'start' && x.args[0] === 'exec').length, 2);
  });
}

test('a recent failed Codex model probe is reused by forced discovery', t => {
  const f = setup(t, { env: { CODEX_PROBE_ERROR: 'model access denied' } });
  const initial = f.run('await d.discover(); console.log(JSON.stringify((await c.readCatalog()).models["codex:gpt-6.1-sol"].available));');
  assert.equal(initial.ok, false); assert.equal(initial.error, 'model access denied');
  f.env.CODEX_PROBE_ERROR = '';
  const cached = f.run('await d.discover({ force: true }); console.log(JSON.stringify((await c.readCatalog()).models["codex:gpt-6.1-sol"].available));');
  assert.deepEqual(cached, initial);
  assert.equal(f.calls().filter(x => x.stage === 'start' && x.args[0] === 'exec').length, 1);
});

test('missing Gemini credentials do not consume the daily probe budget', t => {
  const f = setup(t, { oauth: false });
  f.run('await d.discover(); console.log("{}");');
  mkdirSync(join(f.env.HOME, '.gemini')); writeFileSync(join(f.env.HOME, '.gemini/oauth_creds.json'), '{}');
  const out = f.run('await d.discover({ force: true }); console.log(JSON.stringify((await c.readCatalog()).models["gemini:default"].available));');
  assert.equal(out.ok, true);
  assert.equal(f.calls().filter(x => x.command === 'gemini' && x.stage === 'start').length, 1);
});
