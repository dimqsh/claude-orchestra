import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// test/index.mjs loads every test file into one process: never mutate process.env here.
// Everything that depends on ORCHESTRA_HOME runs in a child process with an explicit env.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'orchestra');
const catalogUrl = pathToFileURL(join(root, 'lib', 'catalog.mjs')).href;
const pathsUrl = pathToFileURL(join(root, 'lib', 'paths.mjs')).href;

const tempHome = () => mkdtempSync(join(tmpdir(), 'orchestra-catalog-'));

// Runs `body` (an ES module body with `catalog` and `paths` in scope) and parses the one JSON line it prints.
function inChild(home, body) {
  const script = `import * as catalog from ${JSON.stringify(catalogUrl)};
import * as paths from ${JSON.stringify(pathsUrl)};
${body}`;
  let out;
  try {
    out = execFileSync(process.execPath, ['--input-type=module', '-e', script],
      { env: { ...process.env, ORCHESTRA_HOME: home }, encoding: 'utf8', timeout: 30000 });
  } catch (error) {
    error.message += `; signal=${error.signal}; stderr=${error.stderr ?? ''}`;
    throw error;
  }
  return JSON.parse(out.trim().split('\n').pop());
}

test('catalog paths live under ORCHESTRA_HOME', () => {
  const home = tempHome();
  const out = inChild(home, `console.log(JSON.stringify({
    catalog: paths.catalogPath(), limits: paths.limitsPath(), jobs: paths.jobsDir() }));`);
  assert.deepEqual(out, { catalog: join(home, 'models.json'), limits: join(home, 'limits.json'), jobs: join(home, 'jobs') });
});

test('TASK_TYPES and entryId follow the spec', () => {
  const out = inChild(tempHome(), `console.log(JSON.stringify({
    types: catalog.TASK_TYPES, id: catalog.entryId('codex', 'gpt-5.6-terra') }));`);
  assert.deepEqual(out.types, ['bug', 'logic', 'refactor', 'tests', 'docs', 'search']);
  assert.equal(out.id, 'codex:gpt-5.6-terra');
});

test('readCatalog returns an empty catalog when the file is missing', () => {
  const out = inChild(tempHome(), `console.log(JSON.stringify(await catalog.readCatalog()));`);
  assert.deepEqual(out, { version: 1, updatedAt: null, discoveredAt: null, benchmarksAt: null, models: {} });
});

test('updateCatalog merges per model without losing other models', () => {
  const home = tempHome();
  const out = inChild(home, `
    const set = (id) => catalog.updateCatalog(c => { c.models[id] = { id, provider: 'codex', model: id.slice(6) }; });
    const returned = await Promise.all([set('codex:a'), set('codex:b')]);
    const stored = await catalog.readCatalog();
    console.log(JSON.stringify({ ids: Object.keys(stored.models).sort(),
      returnedIds: returned.map(c => Object.keys(c.models).length).sort(),
      stamped: typeof stored.updatedAt === 'string' && !Number.isNaN(Date.parse(stored.updatedAt)) }));`);
  assert.deepEqual(out.ids, ['codex:a', 'codex:b']);
  assert.deepEqual(out.returnedIds, [1, 2]);
  assert.equal(out.stamped, true);
  assert.equal(existsSync(join(home, 'models.json.lock')), false, 'lock file is removed after the update');
});

test('updateCatalog keeps fields the mutator does not touch', () => {
  const out = inChild(tempHome(), `
    await catalog.updateCatalog(c => { c.discoveredAt = '2026-10-29T10:00:00Z'; c.models['codex:a'] = { id: 'codex:a', notes: 'first' }; });
    await catalog.updateCatalog(c => { c.models['codex:a'].notes = 'second'; });
    console.log(JSON.stringify(await catalog.readCatalog()));`);
  assert.equal(out.discoveredAt, '2026-10-29T10:00:00Z');
  assert.equal(out.models['codex:a'].notes, 'second');
});

test('readers never see partial JSON', () => {
  const out = inChild(tempHome(), `
    let done = false;
    let reads = 0;
    const reader = (async () => { while (!done) { await catalog.readCatalog(); reads++; } })();
    const writers = Array.from({ length: 50 }, (_, i) => catalog.updateCatalog(c => {
      const id = catalog.entryId('codex', 'm' + i);
      c.models[id] = { id, provider: 'codex', model: 'm' + i, notes: 'x'.repeat(2000) };
    }));
    await Promise.all(writers);
    done = true;
    await reader;
    const final = await catalog.readCatalog();
    console.log(JSON.stringify({ reads, count: Object.keys(final.models).length }));`);
  assert.equal(out.count, 50, 'every concurrent write is kept');
  assert.ok(out.reads > 0);
});

test('an async mutator throws a TypeError, writes nothing and releases the lock', () => {
  const home = tempHome();
  const out = inChild(home, `
    import { readFileSync, existsSync } from 'node:fs';
    await catalog.updateCatalog(c => { c.models['codex:a'] = { id: 'codex:a' }; });
    const file = paths.catalogPath();
    const before = readFileSync(file, 'utf8');
    const attempts = [
      () => catalog.updateCatalog(async c => { c.models['codex:b'] = { id: 'codex:b' }; }),
      () => catalog.updateCatalog(async () => { throw new Error('late failure'); }),
      () => catalog.updateCatalog(c => ({ then() {} })),
    ];
    const errors = [];
    for (const attempt of attempts) {
      try { await attempt(); errors.push(null); } catch (error) { errors.push({ name: error.name, message: error.message }); }
    }
    await new Promise(resolve => setTimeout(resolve, 20)); // lets a late rejection surface as unhandled
    const unchanged = readFileSync(file, 'utf8') === before;
    const lockLeft = existsSync(file + '.lock');
    await catalog.updateCatalog(c => { c.models['codex:c'] = { id: 'codex:c' }; });
    console.log(JSON.stringify({ errors, unchanged, lockLeft, ids: Object.keys((await catalog.readCatalog()).models) }));`);
  assert.equal(out.errors.length, 3);
  for (const error of out.errors) {
    assert.equal(error?.name, 'TypeError');
    assert.match(error.message, /must be synchronous/);
    assert.match(error.message, /outside|before calling updateCatalog/);
  }
  assert.equal(out.unchanged, true, 'models.json is untouched by the rejected updates');
  assert.equal(out.lockLeft, false);
  assert.deepEqual(out.ids, ['codex:a', 'codex:c'], 'a later update works and does not see the rejected changes');
});

test('releasing never removes a lock whose token is not its own', () => {
  const home = tempHome();
  const out = inChild(home, `
    import { readFileSync, existsSync, writeFileSync } from 'node:fs';
    const lock = paths.catalogPath() + '.lock';
    const own = {};
    // Mid-update another process takes the lock over (as it would after a stale timeout).
    await catalog.updateCatalog(c => {
      own.token = readFileSync(lock, 'utf8');
      writeFileSync(lock, 'foreign-token');
      c.models['codex:a'] = { id: 'codex:a' };
    });
    console.log(JSON.stringify({ ownToken: own.token, lockExists: existsSync(lock),
      lock: existsSync(lock) ? readFileSync(lock, 'utf8') : null }));`);
  assert.match(out.ownToken, /^[0-9a-f-]{36}$/, 'the lock file holds a random token while it is held');
  assert.equal(out.lockExists, true, 'the foreign owner\'s lock is left in place');
  assert.equal(out.lock, 'foreign-token');
});

test('a stale lock file from a crashed process does not block updates', () => {
  const home = tempHome();
  const lock = join(home, 'models.json.lock');
  writeFileSync(lock, '');
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const out = inChild(home, `
    await catalog.updateCatalog(c => { c.models['codex:a'] = { id: 'codex:a' }; });
    console.log(JSON.stringify(Object.keys((await catalog.readCatalog()).models)));`);
  assert.deepEqual(out, ['codex:a']);
  assert.equal(existsSync(lock), false);
});

test('allowFable is false unless config says true', () => {
  const home = tempHome();
  const config = join(home, 'config.json');
  const out = inChild(home, `
    import { writeFileSync } from 'node:fs';
    const results = [catalog.allowFable()];
    for (const value of [true, false, 'true', 1]) {
      writeFileSync(${JSON.stringify(config)}, JSON.stringify({ allowFable: value }));
      results.push(catalog.allowFable());
    }
    console.log(JSON.stringify(results));`);
  assert.deepEqual(out, [false, true, false, false, false]);
});
