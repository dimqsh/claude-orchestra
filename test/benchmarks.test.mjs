import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const benchmarksUrl = new URL('../plugins/orchestra/lib/benchmarks.mjs', import.meta.url).href;
const catalogUrl = new URL('../plugins/orchestra/lib/catalog.mjs', import.meta.url).href;
const cliUrl = new URL('../plugins/orchestra/scripts/models.mjs', import.meta.url).href;
const aaUrl = 'https://artificialanalysis.ai/api/v2/data/llms/models';
const benchUrl = 'https://raw.githubusercontent.com/leoncuhk/awesome-llm-bench/main/README.md';
const aa = JSON.parse(readFileSync(new URL('fixtures/aa-models.json', import.meta.url), 'utf8'));
const markdown = readFileSync(new URL('fixtures/benchlm/README.md', import.meta.url), 'utf8');
const oldDate = '2026-01-01';
const oldPublic = { source: 'artificialanalysis.ai', date: oldDate, codingIndex: 42, price: { input: 2, output: 8 } };
const entry = (provider, model, extra = {}) => ({ id: `${provider}:${model}`, provider, model, ...extra });
const models = () => ({
  'codex:gpt-6.1-sol': entry('codex', 'gpt-6.1-sol', { own: { byType: {} }, notes: 'keep' }),
  'claude:sonnet': entry('claude', 'sonnet', { resolved: 'claude-sonnet-5-5' }),
  'codex:unknown': entry('codex', 'unknown'),
});

function setup(t, seed = { models: models() }) {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-benchmarks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, 'orchestra'); mkdirSync(store);
  writeFileSync(join(store, 'models.json'), JSON.stringify({ version: 1, ...seed }));
  const env = { ...process.env, HOME: root, ORCHESTRA_HOME: store, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), ORCHESTRA_AA_KEY: '' };
  function child(body, { aaData = aa, benchText = markdown, aaStatus = 200, benchStatus = 200, network = '', cli = false, args = [], expectedKey = null } = {}) {
    const code = `
      import { existsSync } from 'node:fs';
      import * as c from ${JSON.stringify(catalogUrl)};
      ${cli ? '' : `import * as b from ${JSON.stringify(benchmarksUrl)};`}
      const calls = [];
      const fakeFetch = async (url, options = {}) => {
        if (existsSync(${JSON.stringify(join(store, 'models.json.lock'))})) throw new Error('fetch under catalog lock');
        calls.push({ url, headers: options.headers });
        const isAA = url === ${JSON.stringify(aaUrl)};
        if (isAA && ${JSON.stringify(expectedKey)} !== null && options.headers['x-api-key'] !== ${JSON.stringify(expectedKey)}) throw new Error('wrong key');
        if (!isAA && url !== ${JSON.stringify(benchUrl)}) throw new Error('unexpected URL');
        if (${JSON.stringify(network)} === (isAA ? 'aa' : 'bench') || ${JSON.stringify(network)} === 'both') throw new Error('offline');
        const status = isAA ? ${aaStatus} : ${benchStatus};
        return { ok: status === 200, status, json: async () => (${JSON.stringify(aaData)}), text: async () => ${JSON.stringify(benchText)} };
      };
      ${cli ? `globalThis.fetch = fakeFetch; process.argv = [process.execPath, 'models.mjs', 'benchmarks', ...${JSON.stringify(args)}]; await import(${JSON.stringify(cliUrl)});` : body}
    `;
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  }
  const run = (body = '', options) => {
    const out = child(`${body || 'const result = await b.refreshBenchmarks({ fetch: fakeFetch, key: "test-key" });'}
      console.log(JSON.stringify({ result, catalog: await c.readCatalog(), calls }));`, options);
    assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
    return JSON.parse(out.stdout);
  };
  return { root, store, env, child, run };
}

function copyPlugin(f) {
  const plugin = join(f.root, 'plugin');
  for (const dir of ['lib', 'scripts', 'data']) {
    cpSync(new URL(`../plugins/orchestra/${dir}`, import.meta.url), join(plugin, dir), { recursive: true });
  }
  return plugin;
}

test('missing or malformed aliases never break matching or models discover', t => {
  for (const content of [undefined, '{ malformed', 'null', '{"aliases":null}', '{"aliases":[]}', '{"aliases":{"sonnet-5-5":{"toString":null}}}']) {
    const f = setup(t, { discoveredAt: new Date().toISOString(), models: models() });
    const plugin = copyPlugin(f);
    const aliasPath = join(plugin, 'data/model-aliases.json');
    if (content === undefined) rmSync(aliasPath);
    else writeFileSync(aliasPath, content);
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { matchModel } from ${JSON.stringify(pathToFileURL(join(plugin, 'lib/benchmarks.mjs')).href)};
      import { readCatalog } from ${JSON.stringify(pathToFileURL(join(plugin, 'lib/catalog.mjs')).href)};
      const catalog = await readCatalog();
      console.log(JSON.stringify([matchModel('GPT-6.1 Sol', 'OpenAI', catalog), matchModel('Sonnet 5.5', 'Anthropic', catalog)]));
      process.argv = [process.execPath, 'models.mjs', 'discover'];
      await import(${JSON.stringify(pathToFileURL(join(plugin, 'scripts/models.mjs')).href)});
    `], { env: f.env, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
    assert.equal(out.stdout, '["codex:gpt-6.1-sol",null]\nadded: \nunavailable: \n');
  }
});

test('aliases load lazily and only the aliases key supplies mappings', t => {
  const f = setup(t);
  const plugin = copyPlugin(f);
  const aliasPath = join(plugin, 'data/model-aliases.json');
  writeFileSync(aliasPath, '{}');
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    import { matchModel } from ${JSON.stringify(pathToFileURL(join(plugin, 'lib/benchmarks.mjs')).href)};
    import { readCatalog } from ${JSON.stringify(pathToFileURL(join(plugin, 'lib/catalog.mjs')).href)};
    writeFileSync(${JSON.stringify(aliasPath)}, JSON.stringify({ aliases: { 'sonnet-5-5': 'claude-sonnet-5-5' }, 'gpt-6-sol': 'gpt-6.1-sol' }));
    const catalog = await readCatalog();
    console.log(JSON.stringify([matchModel('Sonnet 5.5', 'Anthropic', catalog), matchModel('GPT-6 Sol', 'OpenAI', catalog)]));
  `], { env: f.env, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  assert.deepEqual(JSON.parse(out.stdout), ['claude:sonnet', null]);
});

// All environment-dependent imports run in isolated children; the directory suite shares one process.
test('AA data fills codingIndex, livecodebench, price and speed with source and date', t => {
  const f = setup(t);
  const { catalog, result, calls } = f.run();
  const pub = catalog.models['codex:gpt-6.1-sol'].public;
  assert.deepEqual(pub, { source: 'artificialanalysis.ai', date: new Date().toISOString().slice(0, 10), codingIndex: 61.2,
    livecodebench: 78, price: { input: 1.25, output: 10, unit: 'USD per 1M tokens' }, outputTokensPerSecond: 140 });
  assert.equal(catalog.models['claude:sonnet'].public.codingIndex, 60);
  assert.deepEqual(catalog.models['codex:gpt-6.1-sol'].own, { byType: {} });
  assert.equal(catalog.models['codex:gpt-6.1-sol'].notes, 'keep');
  assert.deepEqual(result.matched, ['codex:gpt-6.1-sol', 'claude:sonnet']);
  assert.deepEqual(result.unmatched, ['codex:unknown']);
  assert.deepEqual(result.source, ['artificialanalysis.ai', 'benchlm.ai']);
  assert.deepEqual(result.warnings, []);
  assert.equal(calls.filter(x => x.url === aaUrl).length, 1);
  assert.deepEqual(calls.find(x => x.url === aaUrl).headers, { 'x-api-key': 'test-key' });
  assert.ok(Number.isFinite(Date.parse(catalog.benchmarksAt)));
});

test('no key → BenchLM only, warning "no Artificial Analysis key"', t => {
  const seeded = { 'codex:gpt-5.3-codex': entry('codex', 'gpt-5.3-codex'),
    'claude:sonnet': entry('claude', 'sonnet', { resolved: 'claude-sonnet-5' }) };
  const f = setup(t, { models: seeded });
  const { result, catalog, calls } = f.run('const result = await b.refreshBenchmarks({ fetch: fakeFetch });');
  assert.deepEqual(result.warnings, ['no Artificial Analysis key']);
  assert.deepEqual(result.source, ['benchlm.ai']); assert.deepEqual(calls.map(x => x.url), [benchUrl]);
  assert.deepEqual(catalog.models['codex:gpt-5.3-codex'].public, { source: 'benchlm.ai', date: new Date().toISOString().slice(0, 10), swebench: 85, terminalbench: 77.3 });
  assert.equal(catalog.models['claude:sonnet'].public.swebench, 85.2);
  assert.equal(catalog.models['claude:sonnet'].public.terminalbench, undefined);
});

for (const failure of [{ aaStatus: 401 }, { aaStatus: 429 }, { network: 'aa' }, { aaData: {} }]) {
  test(`AA failure ${JSON.stringify(failure)} keeps previous public data and its old date`, t => {
    const f = setup(t, { benchmarksAt: `${oldDate}T00:00:00.000Z`, models: {
      'codex:gpt-6.1-sol': entry('codex', 'gpt-6.1-sol', { public: oldPublic }),
      // This model also exists in the mirror: a failed AA refresh must not replace its old source/date.
      'codex:gpt-5.3-codex': entry('codex', 'gpt-5.3-codex', { public: oldPublic }),
    } });
    const out = f.run('', failure);
    for (const model of Object.values(out.catalog.models)) assert.deepEqual(model.public, oldPublic);
    assert.equal(out.catalog.benchmarksAt, `${oldDate}T00:00:00.000Z`);
    assert.ok(out.result.warnings.length > 0);
    assert.doesNotMatch(JSON.stringify(out.result), /test-key/);
  });
}

test('matchModel never matches a look-alike and requires a concrete Claude resolution', t => {
  const f = setup(t);
  const out = f.run(`const catalog = await c.readCatalog(); const result = [
    b.matchModel('GPT-6 Sol', 'OpenAI', catalog), b.matchModel('GPT-6.1 Sol', 'OpenAI', catalog),
    b.matchModel('OpenAI/GPT-6.1 Sol', 'OpenAI', catalog), b.matchModel('Claude Sonnet 5.5', 'Anthropic', catalog),
    b.matchModel('Sonnet 5.5', 'Anthropic', catalog), b.matchModel('Claude Sonnet 5', 'Anthropic', catalog),
    b.matchModel('GPT-6.1 Sol (High)', 'OpenAI', catalog),
  ]; delete catalog.models['claude:sonnet'].resolved;
  result.push(b.matchModel('Claude Sonnet 5.5', 'Anthropic', catalog));
  result.push(b.matchModel('Sonnet 5.5', 'Anthropic', catalog));`);
  assert.deepEqual(out.result, [null, 'codex:gpt-6.1-sol', 'codex:gpt-6.1-sol', 'claude:sonnet', 'claude:sonnet', null, null, null, null]);
});

test('unmatched models get public: { source: null, note: "no public data" }', t => {
  const f = setup(t);
  assert.deepEqual(f.run().catalog.models['codex:unknown'].public, { source: null, note: 'no public data' });
});

test('BenchLM fills only models AA does not cover', t => {
  const seeded = models(); seeded['codex:gpt-5.3-codex'] = entry('codex', 'gpt-5.3-codex');
  const f = setup(t, { models: seeded });
  const out = f.run();
  assert.equal(out.catalog.models['codex:gpt-6.1-sol'].public.source, 'artificialanalysis.ai');
  assert.equal(out.catalog.models['codex:gpt-5.3-codex'].public.source, 'benchlm.ai');
});

test('fresh AA figures replace old BenchLM figures even when the mirror is offline', t => {
  const f = setup(t, { models: { 'codex:gpt-6.1-sol': entry('codex', 'gpt-6.1-sol', {
    public: { source: 'benchlm.ai', date: oldDate, terminalbench: 50 },
  }) } });
  const out = f.run('', { network: 'bench' });
  assert.equal(out.catalog.models['codex:gpt-6.1-sol'].public.source, 'artificialanalysis.ai');
  assert.equal(out.catalog.models['codex:gpt-6.1-sol'].public.codingIndex, 61.2);
});

test('a recent complete catalog skips; force, seven days, and missing public refresh', t => {
  const seeded = models();
  for (const model of Object.values(seeded)) model.public = { source: null, note: 'no public data' };
  const f = setup(t, { benchmarksAt: new Date().toISOString(), models: seeded });
  const skip = f.run();
  assert.deepEqual(skip.result, { matched: [], unmatched: [], source: [], warnings: [] }); assert.deepEqual(skip.calls, []);
  assert.equal(f.run('const result = await b.refreshBenchmarks({ fetch: fakeFetch, key: "test-key", force: true });').calls.length, 2);
  const stale = f.run('await c.updateCatalog(x => { x.benchmarksAt = new Date(Date.now() - 7 * 86400000 - 1000).toISOString(); }); const result = await b.refreshBenchmarks({ fetch: fakeFetch, key: "test-key" });');
  assert.equal(stale.calls.length, 2);
  const missing = f.run('await c.updateCatalog(x => { x.models["codex:new"] = { provider: "codex", model: "new", public: null }; }); const result = await b.refreshBenchmarks({ fetch: fakeFetch, key: "test-key" });');
  assert.equal(missing.calls.length, 2);
});

for (const failure of [{ aaStatus: 429 }, { network: 'both' }]) {
  test(`new models stay unchecked after ${JSON.stringify(failure)} so the next refresh retries`, t => {
    const benchmarksAt = new Date(Date.now() - 2 * 86400000).toISOString();
    const f = setup(t, { benchmarksAt, models: {
      'codex:gpt-6.1-sol': entry('codex', 'gpt-6.1-sol'),
      'claude:sonnet': entry('claude', 'sonnet', { resolved: 'claude-sonnet-5-5', public: null }),
      'codex:known': entry('codex', 'known', { public: oldPublic }),
    } });
    const failed = f.run('', failure);
    assert.equal(failed.calls.length, 2);
    assert.equal(Object.hasOwn(failed.catalog.models['codex:gpt-6.1-sol'], 'public'), false);
    assert.equal(failed.catalog.models['claude:sonnet'].public, null);
    assert.deepEqual(failed.catalog.models['codex:known'].public, oldPublic);
    assert.equal(failed.catalog.benchmarksAt, benchmarksAt);
    const retried = f.run();
    assert.equal(retried.calls.length, 2, 'a recent benchmarksAt must not suppress retries for unchecked entries');
    assert.equal(retried.catalog.models['codex:gpt-6.1-sol'].public.source, 'artificialanalysis.ai');
    assert.equal(retried.catalog.models['claude:sonnet'].public.source, 'artificialanalysis.ai');
  });
}

test('BenchLM HTTP, network and format failures preserve its last good data and date', t => {
  for (const failure of [{ benchStatus: 429 }, { network: 'both' }, { benchText: '# Changed layout' }]) {
    const pub = { source: 'benchlm.ai', date: oldDate, swebench: 85, terminalbench: 77.3 };
    const f = setup(t, { models: { 'codex:gpt-5.3-codex': entry('codex', 'gpt-5.3-codex', { public: pub }) } });
    const out = f.run('', failure);
    assert.deepEqual(out.catalog.models['codex:gpt-5.3-codex'].public, pub);
    assert.ok(out.result.warnings.length > 0);
  }
});

test('AA null metrics are not invented as zero; real zeroes are retained', t => {
  const f = setup(t);
  const row = { ...aa.data[0], evaluations: { artificial_analysis_coding_index: 0, livecodebench: null }, pricing: { price_1m_input_tokens: 0, price_1m_output_tokens: 0 }, median_output_tokens_per_second: null };
  const pub = f.run('', { aaData: { data: [row] } }).catalog.models['codex:gpt-6.1-sol'].public;
  assert.equal(pub.codingIndex, 0); assert.equal(pub.livecodebench, undefined); assert.equal(pub.outputTokensPerSecond, undefined);
  assert.deepEqual(pub.price, { input: 0, output: 0, unit: 'USD per 1M tokens' });
});

test('fetch finishes before the sync mutation and concurrent discovery fields survive', t => {
  const f = setup(t);
  const out = f.run(`let injected = false;
    const fetch = async (...args) => {
      if (!injected) { injected = true; await c.updateCatalog(x => { x.models['codex:gpt-6.1-sol'].notes = 'concurrent'; x.models['claude:sonnet'].resolved = 'claude-sonnet-5'; }); }
      return fakeFetch(...args);
    };
    const result = await b.refreshBenchmarks({ fetch, key: 'test-key' });`);
  assert.equal(out.catalog.models['codex:gpt-6.1-sol'].notes, 'concurrent');
  assert.equal(out.catalog.models['claude:sonnet'].public.source, 'benchlm.ai');
  assert.equal(out.catalog.models['claude:sonnet'].public.swebench, 85.2);
});

test('benchmarks CLI uses env/config keys, --force, clean output and rejects unknown options', t => {
  const f = setup(t);
  for (const [envKey, configKey, expected] of [['env-key', 'config-key', 'env-key'], ['', 'config-key', 'config-key']]) {
    f.env.ORCHESTRA_AA_KEY = envKey;
    writeFileSync(join(f.store, 'config.json'), JSON.stringify({ artificialAnalysisKey: configKey }));
    const out = f.child('', { cli: true, args: ['--force'], expectedKey: expected });
    assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
    assert.match(out.stdout, /^matched: [^\n]*\nunmatched: [^\n]*\nsource: artificialanalysis.ai, benchlm.ai\n$/);
  }
  const invalid = f.child('', { cli: true, args: ['--unknown'] });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, 'Error: Usage: models.mjs benchmarks [--force]\n');
  f.env.ORCHESTRA_AA_KEY = '';
  writeFileSync(join(f.store, 'config.json'), '{}');
  const noKey = f.child('', { cli: true, args: ['--force'] });
  assert.equal(noKey.status, 0); assert.equal(noKey.stderr, 'Warning: no Artificial Analysis key\n');
  assert.match(noKey.stdout, /\nsource: benchlm.ai\n$/);
});
