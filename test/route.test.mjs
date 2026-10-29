import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
  entry('codex', 'weak', 70, 0.1),
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
  return { root, store, env, child, run, brief };
}

// The numeric choices below are routing policy, not claims about actual provider pricing.
test('rung 1 is the cheapest candidate at or above 85% of the best', t => {
  const f = fixture(t);
  const input = candidates();
  // Even inside a cost class, the cheaper actual blended price wins over the higher score.
  input.models['claude:cheap'].public.price = { input: 0, output: 2 }; // 3:1 blend = 0.5
  input.models['codex:near'] = entry('codex', 'near', 89, 0.8);
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  assert.equal(rows[0].rung, 1);
  assert.equal(rows[0].id, 'claude:cheap');
  assert.equal(rows[0].score.value, 85);
  assert.equal(rows[0].cost, '$');
  assert.equal(rows[0].lowLimit, false);
  assert.deepEqual(rows.map(row => row.rung), [1, 2, 3]);
  assert.equal(rows[2].id, 'codex:best');
  assert.equal(rows[0].effort, 'medium');
  assert.equal(rows[1].effort, 'high');
  assert.equal(rows[2].effort, 'high');
  assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
});

test('rung 2 is at least 5 points higher or one cost class up', t => {
  const f = fixture(t);
  for (const [value, price] of [[90, 0.8], [86, 2], [85, 2], [80, 2]]) {
    const input = catalog(entry('claude', 'cheap', 85, 0.5), entry('codex', 'near', 89, 0.6),
      entry('codex', 'step', value, price), entry('codex', 'best', 100, 20));
    const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
    assert.equal(rows[1].rung, 2);
    if (value === 80) {
      assert.equal(rows.some(row => row.id === 'codex:step'), false);
      assert.equal(rows[1].id, 'codex:best');
    } else {
      assert.equal(rows[1].id, 'codex:step');
    }
    assert.ok(rows[1].score.value >= rows[0].score.value + 5 ||
      (rows[1].cost.length > rows[0].cost.length && rows[1].score.value >= rows[0].score.value));
  }
});

test('a provider above 90% is marked low limit and skipped for rung 1', t => {
  const f = fixture(t);
  const input = catalog(entry('claude', 'cheap', 85, 0.5), entry('codex', 'safe', 86, 2), entry('claude', 'best', 100, 20));
  const limits = { claude: [{ usedPercent: 91 }] };
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, ${JSON.stringify(limits)}, {})`);
  assert.equal(rows[0].id, 'codex:safe');
  assert.equal(rows.at(-1).id, 'claude:best');
  assert.equal(rows.at(-1).lowLimit, true);
  const at90 = f.run(`r.ladder('bug', ${JSON.stringify(input)}, { claude: [{ usedPercent: 90 }] }, {})`);
  assert.equal(at90[0].id, 'claude:cheap');
  const allLow = f.run(`r.ladder('bug', ${JSON.stringify(catalog(entry('codex', 'best', 100, 20)))}, { codex: [{ usedPercent: 1 }, { usedPercent: 95 }] }, {})`);
  assert.equal(allLow.some(row => row.rung === 1), false);
  assert.equal(allLow.at(-1).rung, 3);
  assert.equal(allLow.at(-1).lowLimit, true);
});

test('history with 5 tasks overrides public scores, using the fraction from history()', t => {
  const f = fixture(t);
  const a = entry('codex', 'a', 80, 0.5, { own: { byType: { bug: { passed: 1, total: 1 } } } });
  const b = entry('codex', 'b', 70, 2);
  const history = { [a.id]: { bug: { tasks: 5, firstTry: 2 / 5, avgTokens: 100 } },
    [b.id]: { bug: { tasks: 5, firstTry: 1, avgTokens: null } } };
  const out = f.run(`({ a: r.score(${JSON.stringify(a)}, 'bug', h), b: r.score(${JSON.stringify(b)}, 'bug', h),
    rows: r.ladder('bug', ${JSON.stringify(catalog(a, b))}, {}, h) })`, `const h = ${JSON.stringify(history)};`);
  assert.deepEqual(out.a, { value: 40, evidence: 'history 5 tasks, 40% first try' });
  assert.equal(out.b.value, 100);
  assert.equal(out.rows[0].id, b.id);
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'docs', ${JSON.stringify(history)}).value`), 80);
  history[a.id].bug.tasks = 4;
  assert.ok(Math.abs(f.run(`r.score(${JSON.stringify(a)}, 'bug', ${JSON.stringify(history)}).value`) - 580 / 9) < 1e-9);
});

test('own per-type pass rate adjusts the public prior and evidence names the sources and date', t => {
  const f = fixture(t);
  const a = entry('codex', 'a', 74, 2, { own: { byType: { bug: { passed: 6, total: 6 } } } });
  const result = f.run(`r.score(${JSON.stringify(a)}, 'bug', {})`);
  assert.ok(Math.abs(result.value - 89.6) < 1e-9); // Six observations get weight 6 / (6 + 4).
  assert.match(result.evidence, /own 6\/6 · AA 74/);
  assert.match(result.evidence, /2026-10-28/);
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'docs', {}).value`), 74);
  a.public = { source: null, note: 'no public data' };
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'bug', {}).value`), 80);
  assert.deepEqual(f.run(`r.score(${JSON.stringify(a)}, 'docs', {})`), { value: 50, evidence: 'no public data · neutral prior 50' });
  a.own.byType.bug = { passed: 0, total: 0 };
  assert.equal(f.run(`r.score(${JSON.stringify(a)}, 'bug', {}).value`), 50);
  a.public = { source: 'benchlm.ai', date, swebench: 81, terminalbench: 50 };
  const fallback = f.run(`r.score(${JSON.stringify(a)}, 'bug', {})`);
  assert.equal(fallback.value, 81);
  assert.match(fallback.evidence, /BenchLM SWE-bench 81/);
});

test('cost classes use 3:1 blended prices and model then provider defaults without changing aliases', t => {
  const f = fixture(t);
  for (const [price, expected] of [[0, '$'], [1, '$'], [1.01, '$$'], [5, '$$'], [5.01, '$$$'], [15, '$$$'], [15.01, '$$$$']]) {
    assert.equal(f.run(`r.costClass(${JSON.stringify(entry('codex', 'a', 80, price))})`), expected);
  }
  const a = entry('codex', 'a', 80, 0);
  a.public.price = { input: 0, output: 4 }; // Blend = 1, not the 2 of a 1:1 average.
  assert.equal(f.run(`r.costClass(${JSON.stringify(a)})`), '$');
  const aliases = JSON.parse(readFileSync(aliasesUrl, 'utf8'));
  assert.equal(aliases.aliases['sonnet-5-5'], 'claude-sonnet-5-5');
  for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
    a.provider = provider; a.public.price = { input: null, output: null };
    assert.equal(f.run(`r.costClass(${JSON.stringify(a)})`), aliases.providerCostClasses[provider]);
    assert.match(aliases.providerCostClasses[provider], /^\${1,4}$/);
  }
  assert.deepEqual(aliases.modelCostClasses, { 'claude:haiku': '$', 'claude:sonnet': '$$', 'claude:fable': '$$$' });
  for (const [model, expected] of [['haiku', '$'], ['sonnet', '$$'], ['fable', '$$$']]) {
    const modelEntry = entry('claude', model, null, null, { public: null });
    assert.equal(f.run(`r.costClass(${JSON.stringify(modelEntry)})`), expected);
    modelEntry.public = { price: { input: 20, output: 20 } };
    assert.equal(f.run(`r.costClass(${JSON.stringify(modelEntry)})`), '$$$$', 'an actual price overrides defaults');
  }
  assert.equal(f.run(`r.costClass({ provider: 'unknown' })`), '$$');
});

test('tied own 1/1 results without public data give three rungs cheapest first', t => {
  const input = catalog(...[['claude', 'haiku'], ['claude', 'sonnet'], ['codex', 'gpt-6.1-sol']]
    .map(([provider, model]) => entry(provider, model, null, null, { public: null,
      own: { byType: { bug: { passed: 1, total: 1 } } } })));
  const f = fixture(t, input);
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  assert.deepEqual(rows.map(row => [row.rung, row.id, row.cost, row.score.value]), [
    [1, 'claude:haiku', '$', 60], [2, 'claude:sonnet', '$$', 60], [3, 'codex:gpt-6.1-sol', '$$$', 60],
  ]);
  const out = f.brief(['--types', 'bug']);
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  assert.match(out.stdout, /^bug 3\. codex:gpt-6\.1-sol@high · 60 · own 1\/1/m);
  assert.doesNotMatch(out.stdout, /^untested:/m);
});

test('best breaks score ties by higher cost class, then higher prior, then catalog order', t => {
  const f = fixture(t);
  const cheap = entry('codex', 'cheap', 80, 0.5);
  const a = entry('codex', 'a', 60, 2, { own: { byType: { bug: { passed: 0, total: 2 } } } });
  const b = entry('codex', 'b', 80, 2, { own: { byType: { bug: { passed: 0, total: 4 } } } });
  cheap.own = { byType: { bug: { passed: 0, total: 4 } } };
  const c = { ...b, id: 'codex:c', model: 'c' };
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(catalog(c, a, b, cheap))}, {}, {})`);
  assert.deepEqual(rows.map(row => [row.rung, row.id, row.score.value]), [[1, cheap.id, 40], [2, a.id, 40], [3, c.id, 40]]);
});

test('same-class own 1/1 ties keep provider listing order for best and id order for rung 1', t => {
  const models = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.6-luna']
    .map(model => entry('codex', model, null, null, { public: null,
      own: { byType: { bug: { passed: 1, total: 1 } } } }));
  const f = fixture(t);
  for (const ordered of [models, [...models].reverse()]) {
    const rows = f.run(`r.ladder('bug', ${JSON.stringify(catalog(...ordered))}, {}, {})`);
    assert.equal(rows.at(-1).id, ordered[0].id);
    assert.equal(rows.at(-1).score.value, 60);
    assert.equal(rows[0].id, 'codex:gpt-5.6-luna');
    assert.equal(rows[0].rung, 1);
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
  const tied = f.run(`r.ladder('bug', ${JSON.stringify(catalog(b, a))}, {}, {})`);
  assert.equal(tied[0].id, a.id);
  assert.equal(tied.at(-1).id, b.id);
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
  assert.match(out.stdout, /codex:best@high/);
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
  assert.match(limited.stdout, /codex:best@high[^\n]*low limit/);
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
  const a = entry('codex', 'a', 80, 0.5), b = entry('codex', 'b', 70, 2);
  const f = fixture(t, catalog(a, b));
  const boards = join(f.store, 'boards'); mkdirSync(boards);
  writeFileSync(join(boards, 'history.json'), JSON.stringify({ tasks: [a, b].flatMap(model =>
    Array.from({ length: 5 }, (_, i) => ({ type: 'bug', attempts: [{ n: 1, provider: model.provider,
      model: model.model, outcome: model === a && i >= 2 ? 'rework' : 'accepted', tokens: 100 }] }))) }));
  const before = readFileSync(join(f.store, 'models.json'), 'utf8');
  const out = f.brief(['--types', 'bug']);
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  assert.match(out.stdout, /^bug .*codex:b.*history 5 tasks, 100% first try/m);
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

test('rung 2 cannot downgrade when a safe rung 1 ties the low-limit best', t => {
  const f = fixture(t);
  const input = catalog(entry('codex', 'limited', 90, 10), entry('claude', 'safe', 90, 0.5),
    entry('codex', 'downgrade', 85, 2));
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, { codex: [{ usedPercent: 95 }] }, {})`);
  assert.deepEqual(rows.map(row => [row.rung, row.id]), [[1, 'claude:safe'], [2, 'codex:limited']]);
  assert.ok(rows.every(row => row.score.value >= rows[0].score.value));
});

test('own and small history samples pool with weight n / (n + 4)', t => {
  const f = fixture(t);
  const a = entry('codex', 'a', 61, 2, { own: { byType: { bug: { passed: 1, total: 1 } } } });
  const first = f.run(`r.score(${JSON.stringify(a)}, 'bug', {})`);
  assert.ok(Math.abs(first.value - 68.8) < 1e-9);
  assert.ok(first.value - 61 <= 8);
  const past = { [a.id]: { bug: { tasks: 3, firstTry: 1 / 3 } } };
  const pooled = f.run(`r.score(${JSON.stringify(a)}, 'bug', ${JSON.stringify(past)})`);
  assert.ok(Math.abs(pooled.value - 55.5) < 1e-9); // n=4, passes=2, prior=61.
  assert.match(pooled.evidence, /own 1\/1/);
  assert.match(pooled.evidence, /history 3 tasks, 33% first try/);
  assert.match(pooled.evidence, /AA 61/);
  a.own = null;
  const historyOnly = f.run(`r.score(${JSON.stringify(a)}, 'bug', ${JSON.stringify(past)})`);
  assert.ok(Math.abs(historyOnly.value - 344 / 7) < 1e-9);
  a.public = null;
  const neutral = f.run(`r.score(${JSON.stringify(a)}, 'bug', ${JSON.stringify(past)})`);
  assert.ok(Math.abs(neutral.value - 300 / 7) < 1e-9);
  assert.match(neutral.evidence, /neutral prior/);
});

test('one own pass without public data uses the neutral prior and cannot leapfrog stronger evidence', t => {
  const f = fixture(t);
  const unknown = entry('codex', 'unknown', null, 0.5, { public: null,
    own: { byType: { bug: { passed: 1, total: 1 } } } });
  const input = catalog(unknown, entry('claude', 'a', 61, 0.1), entry('codex', 'b', 70, 2),
    entry('codex', 'best', 79, 20));
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  const row = rows.find(row => row.id === unknown.id);
  assert.equal(row.score.value, 76); // Median 70, one success with weight 1/5.
  assert.match(row.score.evidence, /own 1\/1/);
  assert.match(row.score.evidence, /neutral prior 70/);
  assert.equal(rows.at(-1).id, 'codex:best');
});

test('an even-sized cohort prints its neutral prior rounded to one decimal while the score stays exact', t => {
  const f = fixture(t);
  const unknown = entry('codex', 'unknown', null, 0.5, { public: null,
    own: { byType: { bug: { passed: 1, total: 1 } } } });
  const input = catalog(unknown, entry('claude', 'a', 61.3, 0.1), entry('codex', 'b', 70.1, 2));
  const row = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`).find(row => row.id === unknown.id);
  assert.match(row.score.evidence, /neutral prior 65\.7$/);
  // The score keeps the unrounded median: 61.3 and 70.1 average to 65.69999999999999.
  assert.equal(row.score.value, (4 * ((61.3 + 70.1) / 2) + 100) / 5);
});

test('one primary public metric prevents a lone SWE-bench figure from outranking AA evidence', t => {
  const f = fixture(t);
  const lone = entry('codex', 'swe-only', null, 0.5, {
    public: { source: 'benchlm.ai', date, swebench: 99, price: { input: 0.5, output: 0.5 } },
  });
  const input = catalog(entry('codex', 'a', 61, 0.1), entry('claude', 'b', 70, 2),
    entry('codex', 'best', 79, 20), lone);
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  assert.equal(rows.some(row => row.id === lone.id), false);
  assert.deepEqual(f.run(`r.untested('bug', ${JSON.stringify(input)}, {}, {})`), [lone.id]);
  assert.equal(rows.at(-1).id, 'codex:best');
});

test('without AA, the most-covered metric is SWE-bench and Terminal-Bench-only is untested', t => {
  const f = fixture(t);
  const a = entry('codex', 'a', null, 0.5, { public: { source: 'benchlm.ai', date, swebench: 70,
    price: { input: 0.5, output: 0.5 } } });
  const best = entry('claude', 'best', null, 20, { public: { source: 'benchlm.ai', date, swebench: 80,
    price: { input: 20, output: 20 } } });
  const other = entry('codex', 'terminal-only', null, 0.8, { public: { source: 'benchlm.ai', date, terminalbench: 99,
    price: { input: 0.8, output: 0.8 } } });
  const excluded = entry('codex', 'offline', 100, 0, { available: { ok: false } });
  const input = catalog(a, best, other, excluded, entry('claude', 'opus', 100, 0), entry('claude', 'fable', 100, 0));
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  assert.equal(rows.some(row => row.id === other.id), false);
  assert.deepEqual(f.run(`r.untested('bug', ${JSON.stringify(input)}, {}, {})`), [other.id]);
  assert.equal(rows.at(-1).id, best.id);
  assert.match(rows.at(-1).score.evidence, /BenchLM SWE-bench 80/);
});

test('metric coverage ties prefer AA, SWE-bench, Terminal-Bench, then LiveCodeBench', t => {
  const f = fixture(t);
  const metrics = ['codingIndex', 'swebench', 'terminalbench', 'livecodebench'];
  for (let i = 0; i < metrics.length - 1; i++) {
    const a = entry('codex', 'a', null, 2, { public: { [metrics[i]]: 60, [metrics[i + 1]]: 99 } });
    const b = entry('codex', 'b', null, 2, { public: { [metrics[i]]: 80, [metrics[i + 1]]: 50 } });
    assert.equal(f.run(`r.ladder('docs', ${JSON.stringify(catalog(a, b))}, {}, {})`).at(-1).id, b.id);
  }
});

test('efforts use medium then high with nearest lower fallback before any higher value', t => {
  const f = fixture(t);
  const base = candidates();
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(base)}, {}, {})`);
  assert.deepEqual(rows.map(row => row.effort), ['medium', 'high', 'high']);
  for (const [efforts, first, step] of [
    [['low', 'xhigh'], 'low', 'low'], [['xhigh', 'max'], 'xhigh', 'xhigh'],
    [['high', 'low'], 'low', 'high'], [['minimal', 'none'], 'minimal', 'minimal'],
    [[], null, null],
  ]) {
    for (const model of Object.values(base.models)) model.efforts = efforts;
    const rows = f.run(`r.ladder('bug', ${JSON.stringify(base)}, {}, {})`);
    assert.deepEqual(rows.map(row => row.effort), [first, step, step]);
  }
  const single = entry('codex', 'only', 80, 2);
  assert.equal(f.run(`r.ladder('bug', ${JSON.stringify(catalog(single))}, {}, {})`)[0].effort, 'high');
  const noEffort = fixture(t, catalog({ ...single, efforts: [] }));
  const out = noEffort.brief(['--types', 'bug']);
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  assert.doesNotMatch(out.stdout, /@/);
});

test('the 85% bar tolerates floating-point noise but excludes genuinely lower scores', t => {
  const f = fixture(t);
  const cheap = entry('claude', 'cheap', 52.87, 0.5), best = entry('codex', 'best', 62.2, 20);
  assert.ok(best.public.codingIndex * 0.85 > cheap.public.codingIndex);
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(catalog(cheap, best))}, {}, {})`);
  assert.equal(rows[0].id, cheap.id);
  cheap.public.codingIndex -= 1e-6;
  assert.equal(f.run(`r.ladder('bug', ${JSON.stringify(catalog(cheap, best))}, {}, {})`)[0].id, best.id);
});

test('route import and brief tolerate missing or malformed aliases; cost defaults are loaded lazily', t => {
  const f = fixture(t, catalog(entry('codex', 'subscription', null, null, { public: null })));
  // A private plugin copy avoids changing shared repository data while other tests run.
  const plugin = join(f.root, 'plugin');
  mkdirSync(plugin);
  for (const dir of ['lib', 'scripts', 'data']) cpSync(new URL(`../plugins/orchestra/${dir}/`, import.meta.url), join(plugin, dir), { recursive: true });
  const aliasFile = join(plugin, 'data', 'model-aliases.json');
  const copiedRoute = pathToFileURL(join(plugin, 'lib', 'route.mjs')).href;
  const copiedCLI = pathToFileURL(join(plugin, 'scripts', 'models.mjs')).href;
  for (const content of [null, '{broken', 'null', '{}', '{"providerCostClasses":null}',
    '{"providerCostClasses":[]}', '{"providerCostClasses":{"codex":"wrong"}}',
    '{"modelCostClasses":null}', '{"modelCostClasses":[]}', '{"modelCostClasses":{"codex:subscription":7}}']) {
    if (content === null) rmSync(aliasFile); else writeFileSync(aliasFile, content);
    const out = f.child(`const r = await import(${JSON.stringify(copiedRoute)});
      const entry = { id: 'codex:subscription', provider: 'codex', model: 'subscription', public: null };
      const before = r.costClass(entry);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(${JSON.stringify(aliasFile)}, JSON.stringify({ providerCostClasses: { codex: '$$$$' } }));
      const provider = r.costClass(entry);
      writeFileSync(${JSON.stringify(aliasFile)}, JSON.stringify({ modelCostClasses: { 'codex:subscription': '$' }, providerCostClasses: { codex: '$$$$' } }));
      const model = r.costClass(entry);
      writeFileSync(${JSON.stringify(aliasFile)}, JSON.stringify({ modelCostClasses: { 'codex:subscription': 'wrong' }, providerCostClasses: { codex: '$$$' } }));
      console.log(JSON.stringify([before, provider, model, r.costClass(entry)]));`);
    assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
    assert.deepEqual(JSON.parse(out.stdout), ['$$', '$$$$', '$', '$$$']);
    if (content === null) rmSync(aliasFile); else writeFileSync(aliasFile, content);
    const brief = f.child(`globalThis.fetch = () => { throw new Error('unexpected network'); };
      process.argv = [process.execPath, 'models.mjs', 'brief', '--types', 'bug'];
      await import(${JSON.stringify(copiedCLI)});`);
    assert.equal(brief.status, 0, brief.stderr); assert.equal(brief.stderr, '');
    assert.match(brief.stdout, /^bug no evidence yet$/m);
    assert.match(brief.stdout, /^untested: codex:subscription \(models.mjs bench --models codex:subscription\)$/m);
    assert.match(brief.stdout, /^Limits:/m);
  }
});

test('only evidence-backed models form rungs; all other eligible models are untested', t => {
  const known = entry('codex', 'known', 70, 20);
  const unknown = ['a', 'b', 'c'].map(model => entry('claude', model, null, 0.1, { public: null }));
  const input = catalog(known, ...unknown);
  const f = fixture(t, input);
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  assert.deepEqual(rows.map(row => [row.rung, row.id, row.score.value]), [[1, known.id, 70]]);
  assert.deepEqual(f.run(`r.untested('bug', ${JSON.stringify(input)}, {}, {})`), unknown.map(model => model.id));
  known.public = null;
  assert.deepEqual(f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`), []);
  assert.deepEqual(f.run(`r.untested('bug', ${JSON.stringify(input)}, {}, {})`), [known, ...unknown].map(model => model.id));
});

test('skipped models stay off untested but can rank with public evidence', t => {
  const skipped = entry('claude', 'haiku', null, null, { public: null, own: { skipped: 'not picked', date } });
  const known = entry('claude', 'sonnet', 80, 2, { own: { skipped: 'not picked', date } });
  const unknown = entry('codex', 'unknown', null, null, { public: null });
  const input = catalog(skipped, known, unknown), f = fixture(t, input);
  assert.deepEqual(f.run(`r.untested('bug', ${JSON.stringify(input)}, {}, {})`), [unknown.id]);
  assert.deepEqual(f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`).map(row => row.id), [known.id]);
  const out = f.brief(['--types', 'bug']);
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  assert.match(out.stdout, /^untested: codex:unknown \(models.mjs bench --models codex:unknown\)$/m);
  assert.doesNotMatch(out.stdout, /claude:haiku/);
});

test('own and history observations count as evidence for their type using the score sample count', t => {
  const own = entry('codex', 'own', null, 0.5, { public: null, own: { byType: { bug: { passed: 1, total: 1 } } } });
  const historical = entry('claude', 'history', null, 20, { public: null });
  const invalid = entry('codex', 'invalid', null, 0.1, { public: null, own: { byType: { bug: { passed: 2, total: 1 } } } });
  const input = catalog(own, historical, invalid), f = fixture(t, input);
  const past = { [historical.id]: { bug: { tasks: 1, firstTry: 1 } }, [invalid.id]: { bug: { tasks: 2, firstTry: 2 } } };
  const ownRows = f.run(`r.ladder('bug', ${JSON.stringify(catalog(own))}, {}, {})`);
  assert.equal(ownRows[0].id, own.id);
  assert.equal(ownRows[0].score.value, 60);
  assert.match(ownRows[0].score.evidence, /own 1\/1/);
  const historyRows = f.run(`r.ladder('bug', ${JSON.stringify(catalog(historical))}, {}, ${JSON.stringify(past)})`);
  assert.equal(historyRows[0].id, historical.id);
  assert.equal(historyRows[0].score.value, 60);
  assert.match(historyRows[0].score.evidence, /history 1 tasks/);
  assert.deepEqual(f.run(`r.untested('bug', ${JSON.stringify(input)}, {}, ${JSON.stringify(past)})`), [invalid.id]);
  assert.deepEqual(f.run(`r.ladder('docs', ${JSON.stringify(input)}, {}, ${JSON.stringify(past)})`), []);
  assert.deepEqual(f.run(`r.untested('docs', ${JSON.stringify(input)}, {}, ${JSON.stringify(past)})`), [own.id, historical.id, invalid.id]);
});

test('unsupported providers never affect the primary metric, neutral prior, rungs or untested list', t => {
  const own = entry('codex', 'own', null, 0.5, { public: null, own: { byType: { bug: { passed: 1, total: 1 } } } });
  const supported = entry('claude', 'supported', null, 20, { public: { swebench: 70 } });
  const unknown = entry('codex', 'unknown', null, 0.1, { public: null });
  const input = catalog(own, supported, unknown, entry('gemini', 'known', 90, 0.1),
    entry('gemini', 'unknown', null, 0.1, { public: null }), entry('other', 'known', 100, 0));
  const f = fixture(t, input);
  const rows = f.run(`r.ladder('bug', ${JSON.stringify(input)}, {}, {})`);
  const ownRow = rows.find(row => row.id === own.id);
  assert.equal(ownRow.score.value, 76);
  assert.match(ownRow.score.evidence, /neutral prior 70/);
  assert.ok(rows.every(row => /^(codex|claude):/.test(row.id)));
  assert.deepEqual(f.run(`r.untested('bug', ${JSON.stringify(input)}, {}, {})`), [unknown.id]);
});

test('brief with no evidence prints six type messages, one untested line and limits', t => {
  const input = catalog(entry('claude', 'haiku', null, null, { public: null }),
    entry('codex', 'new', null, null, { public: null }), entry('gemini', 'unknown', null, null, { public: null }));
  const f = fixture(t, input), out = f.brief();
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  const lines = out.stdout.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 6), ['bug', 'logic', 'refactor', 'tests', 'docs', 'search'].map(type => `${type} no evidence yet`));
  assert.equal(lines[6], 'untested: claude:haiku, codex:new (models.mjs bench --models claude:haiku,codex:new)');
  assert.match(lines[7], /^Limits:/);
  assert.equal(lines.length, 8);
  assert.doesNotMatch(out.stdout, /neutral prior|no available models|gemini:/);
});

test('brief with all three available models skipped prints no evidence yet without an untested line', t => {
  const input = catalog(...[['claude', 'haiku'], ['claude', 'sonnet'], ['codex', 'gpt-6.1-sol']]
    .map(([provider, model]) => entry(provider, model, null, null, { public: null,
      own: { skipped: 'not picked', date } })));
  const f = fixture(t, input), out = f.brief();
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  const lines = out.stdout.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 6), ['bug', 'logic', 'refactor', 'tests', 'docs', 'search'].map(type => `${type} no evidence yet`));
  assert.equal(lines.length, 7);
  assert.match(lines[6], /^Limits:/);
  assert.doesNotMatch(out.stdout, /no available models|^untested:/m);
});

test('brief with only excluded models prints no available models', t => {
  const input = catalog(entry('claude', 'opus', null, null, { public: null }),
    entry('claude', 'fable', null, null, { public: null }),
    entry('kimi', 'default', null, null, { public: null }),
    entry('gemini', 'default', null, null, { public: null }),
    entry('codex', 'offline', null, null, { public: null, available: { ok: false } }));
  const out = fixture(t, input).brief();
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  assert.deepEqual(out.stdout.trimEnd().split('\n').slice(0, 6),
    ['bug', 'logic', 'refactor', 'tests', 'docs', 'search'].map(type => `${type} no available models`));
  assert.doesNotMatch(out.stdout, /^untested:/m);
});

test('board set reports the friendly error when its board disappears before the synchronous re-read', t => {
  const f = fixture(t);
  const boardUrl = new URL('../plugins/orchestra/scripts/board.mjs', import.meta.url).href;
  const pathsUrl = new URL('../plugins/orchestra/lib/paths.mjs', import.meta.url).href;
  const out = f.child(`
    import fs from 'node:fs';
    import { dirname } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { syncBuiltinESMExports } from 'node:module';
    import { boardPath } from ${JSON.stringify(pathsUrl)};
    const path = boardPath(${JSON.stringify(f.root)});
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, JSON.stringify({ tasks: [{ id: '1', executor: 'codex', attempts: [] }] }));
    const read = fs.readFileSync;
    // Remove the actual file at the re-read boundary, after the async read succeeded.
    fs.readFileSync = (file, ...args) => {
      if (file === path) fs.unlinkSync(path);
      return read(file, ...args);
    };
    syncBuiltinESMExports();
    process.argv = [process.execPath, fileURLToPath(${JSON.stringify(boardUrl)}),
      'set', '1', 'running', '--cwd', ${JSON.stringify(f.root)}];
    await import(${JSON.stringify(boardUrl)});
  `);
  assert.equal(out.status, 1);
  assert.equal(out.stdout, '');
  assert.equal(out.stderr, 'Error: Board not found: run init\n');
});

test('brief lists only models untested for every shown type and stays within 20 lines', t => {
  const input = candidates();
  const partial = entry('codex', 'partial', null, 2, { public: null, own: { byType: { bug: { passed: 1, total: 1 } } } });
  const unknown = entry('claude', 'untested', null, null, { public: null });
  input.models[partial.id] = partial; input.models[unknown.id] = unknown;
  const f = fixture(t, input), out = f.brief();
  assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
  const lines = out.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 20);
  assert.equal(lines.at(-2), 'untested: claude:untested (models.mjs bench --models claude:untested)');
  assert.match(lines.at(-1), /^Limits:/);
  const docs = f.brief(['--types', 'docs']);
  assert.equal(docs.status, 0, docs.stderr); assert.equal(docs.stderr, '');
  assert.match(docs.stdout, /^untested: codex:partial, claude:untested \(models.mjs bench --models codex:partial,claude:untested\)$/m);
  const known = fixture(t, candidates()).brief();
  assert.equal(known.status, 0, known.stderr); assert.equal(known.stderr, '');
  assert.doesNotMatch(known.stdout, /^untested:/m);
});
