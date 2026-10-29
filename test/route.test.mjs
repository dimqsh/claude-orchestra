import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const routeUrl = new URL('../plugins/orchestra/lib/route.mjs', import.meta.url).href;
const cliUrl = new URL('../plugins/orchestra/scripts/models.mjs', import.meta.url).href;
const aliasesUrl = new URL('../plugins/orchestra/data/model-aliases.json', import.meta.url);
const date = '2026-10-28';
const entry = (provider, model, value, price, extra = {}) => ({
  id: `${provider}:${model}`, provider, model, efforts: ['low', 'medium', 'high', 'xhigh'],
  available: { ok: true }, access: 'subscription',
  public: { source: 'artificialanalysis.ai', date, codingIndex: value, price: { input: price, output: price } },
  ...extra,
});
const catalog = (...entries) => ({ models: Object.fromEntries(entries.map(e => [e.id, e])) });
const candidates = () => catalog(
  entry('gemini', 'weak', 70, 0.1),
  entry('claude', 'cheap', 85, 0.5),
  entry('codex', 'step', 90, 2),
  entry('codex', 'best', 100, 20),
);

function fixture(t, seed = candidates()) {
  const root = mkdtempSync(join(tmpdir(), 'orchestra-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = join(root, 'orchestra');
  mkdirSync(store);
  writeFileSync(join(store, 'models.json'), JSON.stringify(seed));
  // Every env-dependent import runs in a child: test/index.mjs shares one process.
  const env = { ...process.env, HOME: root, ORCHESTRA_HOME: store,
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
  const child = body => spawnSync(process.execPath, ['--input-type=module', '-e', body], { env, encoding: 'utf8' });
  const run = (expression, prelude = '') => {
    const out = child(`import * as r from ${JSON.stringify(routeUrl)};
      ${prelude}
      console.log(JSON.stringify(${expression}));`);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, '');
    return JSON.parse(out.stdout);
  };
  const brief = (args = []) => child(`globalThis.fetch = () => { throw new Error('unexpected network'); };
    process.argv = [process.execPath, 'models.mjs', 'brief', ...${JSON.stringify(args)}];
    await import(${JSON.stringify(cliUrl)});`);
  return { root, store, env, run, brief };
}

// The numeric choices below are routing policy, not claims about actual provider pricing.
test('rung 1 is the cheapest candidate at or above 85% of the best', t => {
  const f = fixture(t);
  const input = candidates();
  // Even inside a cost class, the cheaper actual blended price wins over the higher score.
  input.models['claude:cheap'].public.price = { input: 0, output: 2 }; // 3:1 blend = 0.5
  input.models['gemini:near'] = entry('gemini', 'near', 89, 0.8);
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  assert.equal(rows[0].rung, 1);
  assert.equal(rows[0].id, 'claude:cheap');
  assert.equal(rows[0].score.value, 85);
  assert.equal(rows[0].cost, '$');
  assert.equal(rows[0].lowLimit, false);
  assert.deepEqual(rows.map(row => row.rung), [1, 2, 3]);
  assert.equal(rows[2].id, 'codex:best');
  assert.equal(rows[2].effort, 'xhigh');
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
});

test('rung 2 is at least 5 points higher or one cost class up', t => {
  const f = fixture(t);
  for (const [value, price] of [[90, 0.8], [86, 2], [80, 2]]) {
    const input = catalog(entry('claude', 'cheap', 85, 0.5), entry('gemini', 'near', 89, 0.6),
      entry('codex', 'step', value, price), entry('codex', 'best', 100, 20));
    const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
    assert.equal(rows[1].rung, 2);
    assert.equal(rows[1].id, 'codex:step');
    assert.ok(rows[1].score.value >= rows[0].score.value + 5 || rows[1].cost.length > rows[0].cost.length);
  }
});

test('a provider above 90% is marked low limit and skipped for rung 1', t => {
  const f = fixture(t);
  const input = catalog(entry('claude', 'cheap', 85, 0.5), entry('gemini', 'safe', 86, 2), entry('codex', 'best', 100, 20));
  const limits = { claude: [{ usedPercent: 91 }], codex: [{ usedPercent: 1 }, { usedPercent: 95 }] };
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, ${JSON.stringify(limits)}, {})`);
  assert.equal(rows[0].id, 'gemini:safe');
  assert.equal(rows.at(-1).id, 'codex:best');
  assert.equal(rows.at(-1).lowLimit, true);
  const at90 = f.run(`r.ladder('bug', ${JSON.stringify(input)}, { claude: [{ usedPercent: 90 }] }, {})`);
  assert.equal(at90[0].id, 'claude:cheap');
  const allLow = f.run(`r.ladder('bug', ${JSON.stringify(catalog(entry('codex', 'best', 100, 20)))}, ${JSON.stringify(limits)}, {})`);
  assert.equal(allLow.some(row => row.rung === 1), false);
  assert.equal(allLow.at(-1).rung, 3);
  assert.equal(allLow.at(-1).lowLimit, true);
});

test('history with 5 tasks overrides public scores, using the fraction from history()', t => {
  const f = fixture(t);
  const a = entry('codex', 'a', 80, 0.5, { own: { byType: { bug: { passed: 1, total: 1 } } } });
  const b = entry('gemini', 'b', 70, 2);
  const history = { [a.id]: { bug: { tasks: 5, firstTry: 2 / 5, avgTokens: 100 } },
    [b.id]: { bug: { tasks: 5, firstTry: 1, avgTokens: null } } };
  const out = f.run(`({ a: r.score(${JSON.stringify(a)}, 'bug', h), b: r.score(${JSON.stringify(b)}, 'bug', h),
    rows: r.ladder('bug', ${JSON.stringify(catalog(a, b))}, {}, h) })`, `const h = ${JSON.stringify(history)};`);
  assert.deepEqual(out.a, { value: 40, evidence: 'history 5 tasks, 40% first try' });
  assert.equal(out.b.value, 100);
  assert.equal(out.rows[0].id, b.id);
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'docs', ${JSON.stringify(history)}).value`), 80);
  history[a.id].bug.tasks = 4;
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'bug', ${JSON.stringify(history)}).value`), 90);
});

test('own per-type pass rate adjusts the public prior and evidence names the sources and date', t => {
  const f = fixture(t);
  const a = entry('codex', 'a', 74, 2, { own: { byType: { bug: { passed: 6, total: 6 } } } });
  const result = f.run(`r.score(${JSON.stringify(a)}, 'bug', {})`);
  assert.equal(result.value, 87); // Equal weight for the public prior and own rate.
  assert.match(result.evidence, /own 6\/6 · AA 74/);
  assert.match(result.evidence, /2026-10-28/);
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'docs', {}).value`), 74);
  a.public = { source: null, note: 'no public data' };
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'bug', {}).value`), 100);
  assert.deepEqual(f.run(`r.score(${JSON.stringify(a)}, 'docs', {})`), { value: 0, evidence: 'no public data' });
  a.own.byType.bug = { passed: 0, total: 0 };
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'bug', {}).value`), 0);
  a.public = { source: 'benchlm.ai', date, swebench: 81, terminalbench: 50 };
  const fallback = f.run(`r.score(${JSON.stringify(a)}, 'bug', {})`);
  assert.equal(fallback.value, 81);
  assert.match(fallback.evidence, /BenchLM SWE-bench 81/);
});

test('cost classes use 3:1 blended prices and provider defaults without changing aliases', t => {
  const f = fixture(t);
  for (const [price, expected] of [[0, '$'], [1, '$'], [1.01, '$$'], [5, '$$'], [5.01, '$$$'], [15, '$$$'], [15.01, '$$$$']]) {
    assert.equal(f.run(`r.costClass(${JSON.stringify(entry('codex', 'a', 80, price))})`), expected);
  }
  const a = entry('codex', 'a', 80, 0);
  a.public.price = { input: 0, output: 4 }; // Blend = 1, not the 2 of a 1:1 average.
  assert.equal(f.run(`r.costClass(${JSON.stringify(a)})`), '$');
  const aliases = JSON.parse(readFileSync(aliasesUrl, 'utf8'));
  assert.equal(aliases['sonnet-5-5'], 'claude-sonnet-5-5');
  for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
    a.provider = provider; a.public.price = { input: null, output: null };
    assert.equal(f.run(`r.costClass(${JSON.stringify(a)})`), aliases.providerCostClasses[provider]);
    assert.match(aliases.providerCostClasses[provider], /^\${1,4}$/);
  }
});

test('fable never appears unless allowFable; opus and unavailable models never appear', t => {
  const f = fixture(t);
  const input = catalog(entry('claude', 'fable', 100, 20), entry('claude', 'opus', 100, 0),
    entry('claude', 'concrete', 100, 0, { resolved: 'claude-opus-5-5' }),
    entry('claude', 'claude-opus-5-5', 100, 0),
    entry('claude', 'sonnet', 85, 2), entry('codex', 'offline', 100, 0, { available: { ok: false } }),
    entry('kimi', 'default', 100, 0));
  const run = () => f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  assert.deepEqual(run().map(row => row.id), ['claude:sonnet']);
  writeFileSync(join(f.store, 'config.json'), JSON.stringify({ allowFable: true }));
  assert.deepEqual(run().map(row => row.id), ['claude:sonnet', 'claude:fable']);
  input.models['claude:concrete'].resolved = 'claude-fable-5-5';
  delete input.models['claude:fable'];
  writeFileSync(join(f.store, 'config.json'), JSON.stringify({ allowFable: false }));
  assert.deepEqual(run().map(row => row.id), ['claude:sonnet']);
});

test('empty and single-candidate ladders have no duplicate padding; ties are deterministic', t => {
  const f = fixture(t);
  assert.deepEqual(f.run(`r.ladder('bug', { models: {} }, {}, {})`), []);
  const a = entry('codex', 'a', 80, 2, { efforts: [] });
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(catalog(a))}, {}, {})`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].effort, null);
  const b = entry('codex', 'b', 80, 2);
  assert.equal(f.run(`r.ladder('bug', ${JSON.stringify(catalog(b, a))}, {}, {})`)[0].id, a.id);
});

test('brief output is at most 20 lines, contains evidence and one limits line, and honors --types', t => {
  const f = fixture(t);
  writeFileSync(join(f.store, 'limits.json'), JSON.stringify({ claude: { five_hour: { used_percentage: 41 } } }));
  const out = f.brief();
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stderr, '');
  const lines = out.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 19); // Six task types times three rungs plus limits.
  assert.ok(lines.length <= 20);
  for (const type of ['bug', 'logic', 'refactor', 'tests', 'docs', 'search']) assert.ok(lines.some(line => line.startsWith(`${type} `)));
  assert.match(out.stdout, /AA 85.*2026-10-28/);
  assert.match(out.stdout, /codex:best@xhigh/);
  assert.equal(lines.filter(line => line.startsWith('Limits:')).length, 1);
  assert.match(lines.at(-1), /claude 41% used\/5h/);
  assert.match(lines.at(-1), /codex unknown/);
  const sessions = join(f.env.CODEX_HOME, 'sessions', '2026', '10', '30');
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, 'rollout-limits.jsonl'), JSON.stringify({ type: 'event_msg', payload: {
    type: 'token_count', rate_limits: { primary: { window_minutes: 300, used_percent: 95 } },
  } }) + '\n');
  const limited = f.brief(['--types', 'bug']);
  assert.equal(limited.status, 0, limited.stderr); assert.equal(limited.stderr, '');
  assert.match(limited.stdout, /codex:best@xhigh[^\n]*low limit/);
  assert.match(limited.stdout, /Limits:.*codex 95% used\/5h/);
  const selected = f.brief(['--types', 'bug,docs,bug']);
  assert.equal(selected.status, 0, selected.stderr);
  assert.equal(selected.stderr, '');
  assert.equal(selected.stdout.trimEnd().split('\n').length, 7);
  assert.doesNotMatch(selected.stdout, /^(logic|refactor|tests|search) /m);
  for (const args of [['--types'], ['--types', 'bad'], ['--types', 'bug,'], ['--unknown']]) {
    const invalid = f.brief(args);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.equal(invalid.stderr, 'Error: Usage: models.mjs brief [--types bug,docs]\n');
  }
});

test('brief reads real board history and remains read-only with an empty or unavailable catalog', t => {
  const a = entry('codex', 'a', 80, 0.5), b = entry('gemini', 'b', 70, 2);
  const f = fixture(t, catalog(a, b));
  const boards = join(f.store, 'boards'); mkdirSync(boards);
  writeFileSync(join(boards, 'history.json'), JSON.stringify({ tasks: [a, b].flatMap(model =>
    Array.from({ length: 5 }, (_, i) => ({ type: 'bug', attempts: [{ n: 1, provider: model.provider,
      model: model.model, outcome: model === a && i >= 2 ? 'rework' : 'accepted', tokens: 100 }] }))) }));
  const before = readFileSync(join(f.store, 'models.json'), 'utf8');
  const out = f.brief(['--types', 'bug']);
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  assert.match(out.stdout, /^bug .*gemini:b.*history 5 tasks, 100% first try/m);
  assert.doesNotMatch(out.stdout, /codex:a/);
  assert.equal(readFileSync(join(f.store, 'models.json'), 'utf8'), before);
  writeFileSync(join(f.store, 'models.json'), JSON.stringify(catalog({ ...a, available: { ok: false } })));
  const unavailable = f.brief(['--types', 'bug']);
  assert.equal(unavailable.status, 0, unavailable.stderr); assert.equal(unavailable.stderr, '');
  assert.match(unavailable.stdout, /^bug .*no available models/m);
  rmSync(join(f.store, 'models.json'));
  const empty = f.brief(['--types', 'docs']);
  assert.equal(empty.status, 0, empty.stderr); assert.equal(empty.stderr, '');
  assert.match(empty.stdout, /^docs .*no available models/m);
});
