import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openKb, kbPath, projectRoot } from '../plugins/orchestra/lib/kb.mjs';
import { canonicalPath, orchestraHome, projectSlug } from '../plugins/orchestra/lib/paths.mjs';

const script = fileURLToPath(new URL('../plugins/orchestra/scripts/kb.mjs', import.meta.url));

function fixture(t, { open = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'orchestra-kb-'));
  const cwd = join(dir, 'project'), home = join(dir, 'home'), dbPath = join(dir, 'db', 'memory.sqlite');
  mkdirSync(cwd);
  const handles = [];
  t.after(() => {
    for (const kb of handles) kb.close();
    // Restore permissions even when a read-only assertion fails.
    if (existsSync(dirname(dbPath))) chmodSync(dirname(dbPath), 0o700);
    if (existsSync(dbPath)) chmodSync(dbPath, 0o600);
    if (existsSync(join(home, 'kb'))) chmodSync(join(home, 'kb'), 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  function connect(options = {}, at = cwd) {
    const kb = openKb(at, { dbPath, ...options });
    if (kb) handles.push(kb);
    return kb;
  }
  function cli(args, input, at = cwd) {
    return spawnSync(process.execPath, [script, '--cwd', at, ...args], { input, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, ORCHESTRA_HOME: home, CLAUDE_CONFIG_DIR: join(dir, 'claude') } });
  }
  function run(args, input, at) {
    const result = cli(args, input, at);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'no SQLite warning or diagnostics on success');
    return result.stdout.trimEnd();
  }
  function file(path, body) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), body);
  }
  return { dir, cwd, home, dbPath, connect, cli, run, file, kb: open ? connect() : null };
}

test('KB read-only missing database returns null without creating directories', t => {
  const f = fixture(t, { open: false });
  assert.equal(f.connect({ readOnly: true }), null);
  assert.equal(existsSync(dirname(f.dbPath)), false);
  assert.equal(f.run(['stats', '--json']), '{"notes":0,"hits":0,"savedTokens":0,"recent":[]}');
  assert.equal(f.run(['context']), 'Nothing found');
  assert.equal(f.run(['list']), 'Nothing found');
  assert.equal(existsSync(f.home), false);
});

test('KB upsert normalizes title and path sets while preserving identity, creation time and counters', t => {
  const { kb, file } = fixture(t);
  file('a.py', 'old'); file('b.py', 'b');
  const first = kb.add({ kind: 'file', title: '  Sort   TASKS ', body: 'obsoleteword',
    paths: ['b.py', 'a.py', './a.py'], author: 'sonnet #2', taskId: '2' });
  assert.equal(first.updated, false);
  const before = kb.get(first.id);
  kb.search('obsoleteword');
  file('a.py', 'new');
  const again = kb.add({ kind: 'file', title: 'sort tasks', body: 'replacementword',
    paths: ['./b.py', 'a.py'], author: 'codex #1', taskId: '1' });
  assert.deepEqual(again, { id: first.id, updated: true });
  const updated = kb.get(first.id);
  assert.deepEqual(updated.paths, ['a.py', 'b.py']);
  assert.equal(updated.refs['a.py'], createHash('sha1').update('new').digest('hex'));
  assert.equal(updated.createdAt, before.createdAt);
  assert.ok(updated.updatedAt >= before.updatedAt);
  assert.equal(updated.author, 'codex #1'); assert.equal(updated.taskId, '1');
  assert.equal(updated.hits, 1); assert.equal(updated.savedTokens, 200); assert.equal(updated.stale, false);
  assert.deepEqual(kb.search('obsoleteword'), [], 'upsert removes old FTS terms');
  assert.equal(kb.search('replacementword')[0].id, first.id);
  assert.equal(kb.add({ kind: 'symbol', title: 'sort tasks', body: '', paths: ['a.py', 'b.py'] }).updated, false);
  assert.equal(kb.add({ kind: 'file', title: 'sort tasks', body: '', paths: ['a.py'] }).updated, false);
  assert.equal(kb.stats().notes, 3);
});

test('KB FTS5 ranks Russian title matches ahead of body matches and safely handles FTS punctuation', t => {
  const { kb } = fixture(t);
  const best = kb.add({ kind: 'fact', title: 'Сортировка задач', body: 'Срок выполнения учитывается.' });
  const other = kb.add({ kind: 'fact', title: 'Срок выполнения', body: 'Сортировка задач учитывается.' });
  const hits = kb.search('СОРТИРОВКА задач');
  assert.deepEqual(hits.map(hit => hit.id), [best.id, other.id]);
  assert.ok(hits[0].score > hits[1].score);
  assert.deepEqual(kb.search('несуществующее'), []);
  assert.deepEqual(kb.search('" * () :'), []);
  assert.ok(kb.search('NOT задач').length > 0, 'NOT is a literal term, not an injected operator');
});

test('KB indexes snake_case, camelCase, acronym, dotted and slash identifiers in title/body/paths', t => {
  const { kb, file } = fixture(t);
  file('tasklist/core.py', 'source');
  const snake = kb.add({ kind: 'symbol', title: 'Ordering', body: 'sort_tasks(tasks)' });
  const camel = kb.add({ kind: 'symbol', title: 'Exporting', body: 'exportCsv(items)' });
  const dotted = kb.add({ kind: 'file', title: 'Module', body: 'HTTPServer handles requests', paths: ['tasklist/core.py'] });
  for (const query of ['sort tasks', 'sort_tasks', 'sortTasks']) assert.equal(kb.search(query)[0].id, snake.id);
  for (const query of ['export csv', 'exportCsv', 'export-csv']) assert.equal(kb.search(query)[0].id, camel.id);
  for (const query of ['tasklist core', 'tasklist.core.py', 'http server']) assert.equal(kb.search(query)[0].id, dotted.id);
  assert.deepEqual(kb.search('tasklist core', { kind: 'symbol' }), []);
  assert.equal(kb.search('tasklist core', { kind: 'file', path: 'tasklist' })[0].id, dotted.id);
  assert.equal(kb.search('tasklist core', { path: './tasklist/core.py' })[0].id, dotted.id);
  assert.deepEqual(kb.search('tasklist core', { path: 'task' }), []);
});

test('KB hashes actual bytes for freshness, ranks all fresh matches before stale ones, and detects deleted refs', t => {
  const { kb, cwd, file } = fixture(t);
  file('source.py', 'one');
  const stale = kb.add({ kind: 'symbol', title: 'Sort tasks', body: 'sort_tasks', paths: ['source.py'] });
  const fresh = kb.add({ kind: 'fact', title: 'Advice', body: 'Sort tasks' });
  const timestamp = statSync(join(cwd, 'source.py'));
  file('source.py', 'two');
  utimesSync(join(cwd, 'source.py'), timestamp.atime, timestamp.mtime);
  assert.deepEqual(kb.search('sort tasks', { limit: 1 }).map(hit => hit.id), [fresh.id]);
  const hits = kb.search('sort tasks');
  assert.deepEqual(hits.map(hit => [hit.id, hit.stale]), [[fresh.id, false], [stale.id, true]]);
  assert.equal(kb.get(stale.id).hits, 0); assert.equal(kb.get(stale.id).savedTokens, 0);
  assert.equal(kb.stats().recent.find(note => note.id === stale.id).stale, true);
  unlinkSync(join(cwd, 'source.py'));
  assert.equal(kb.get(stale.id).stale, true);
  const missing = kb.add({ kind: 'file', title: 'Missing file', body: 'none', paths: ['missing.py'] });
  assert.equal(kb.get(missing.id).stale, true);
});

test('KB search accounts for returned fresh notes only, with per-hit floor, summed bytes and 8000 cap', t => {
  const { kb, file } = fixture(t);
  file('small', 'x'.repeat(1001)); file('other', 'y'.repeat(999)); file('big', 'z'.repeat(40000));
  const noFiles = kb.add({ kind: 'fact', title: 'floorword', body: '' });
  const summed = kb.add({ kind: 'fact', title: 'sumword', body: '', paths: ['small', 'other'] });
  const capped = kb.add({ kind: 'fact', title: 'capword', body: '', paths: ['big'] });
  kb.search('floorword'); kb.search('floorword'); kb.search('sumword'); kb.search('capword');
  assert.equal(kb.get(noFiles.id).savedTokens, 400);
  assert.equal(kb.get(summed.id).savedTokens, 500);
  assert.equal(kb.get(capped.id).savedTokens, 8000);
  assert.equal(kb.stats().hits, 4); assert.equal(kb.stats().savedTokens, 8900);
  kb.context(); kb.list(); kb.get(capped.id); kb.stats();
  assert.equal(kb.stats().hits, 4, 'non-search reads do not earn savings');
  kb.search('capword'); assert.equal(kb.get(capped.id).savedTokens, 16000, 'cap is per hit');
  const before = kb.stats().hits;
  kb.add({ kind: 'fact', title: 'commonword one', body: '' });
  kb.add({ kind: 'fact', title: 'commonword two', body: '' });
  kb.search('commonword', { limit: 1 });
  assert.equal(kb.stats().hits, before + 1, 'unreturned matches receive no hits');
});

test('KB explicit read-only handles can search without counting and reject all mutations', t => {
  const f = fixture(t);
  f.kb.add({ kind: 'fact', title: 'readonlyword', body: 'data' });
  const reader = f.connect({ readOnly: true });
  assert.equal(reader.search('readonlyword').length, 1);
  assert.equal(reader.stats().hits, 0);
  assert.throws(() => reader.add({ kind: 'fact', title: 'x', body: '' }), /read-only/);
  assert.throws(() => reader.prune({ stale: true }), /read-only/);
});

test('KB automatically falls back to read-only when the database directory or file is unwritable', t => {
  const f = fixture(t);
  f.kb.add({ kind: 'fact', title: 'readonlyword', body: 'data' });
  const before = readFileSync(f.dbPath);
  chmodSync(dirname(f.dbPath), 0o555);
  assert.equal(f.connect().search('readonlyword')[0].title, 'readonlyword');
  assert.equal(f.kb.stats().hits, 0);
  assert.deepEqual(readFileSync(f.dbPath), before);
  assert.deepEqual(readdirSync(dirname(f.dbPath)), ['memory.sqlite'], 'DELETE mode needs no WAL files');
  chmodSync(dirname(f.dbPath), 0o700);
  chmodSync(f.dbPath, 0o444);
  assert.equal(f.connect().search('readonlyword').length, 1);
  assert.equal(f.kb.stats().hits, 0);
});

test('KB context prioritizes context then popular decisions/commands/gotchas; stats, get and list are bounded', t => {
  const { kb } = fixture(t);
  const context = kb.add({ kind: 'context', title: 'Context', body: 'Project description' });
  const decision = kb.add({ kind: 'decision', title: 'decisionword', body: '' });
  const command = kb.add({ kind: 'command', title: 'commandword', body: '' });
  const gotcha = kb.add({ kind: 'gotcha', title: 'gotchaword', body: '' });
  kb.add({ kind: 'fact', title: 'factword', body: '' });
  for (let i = 0; i < 3; i++) kb.search('commandword');
  for (let i = 0; i < 2; i++) kb.search('decisionword');
  kb.search('gotchaword');
  assert.deepEqual(kb.context().map(note => note.id), [context.id, command.id, decision.id, gotcha.id]);
  assert.equal(kb.context({ limit: 2 }).length, 2);
  for (let i = 0; i < 10; i++) kb.add({ kind: 'file', title: `File ${i}`, body: '' });
  const stats = kb.stats();
  assert.equal(stats.notes, 15); assert.equal(stats.hits, 6); assert.equal(stats.savedTokens, 1200);
  assert.equal(stats.recent.length, 8); assert.equal(stats.recent[0].title, 'File 9');
  assert.ok(stats.recent.every((row, i, rows) => !i || row.updatedAt <= rows[i - 1].updatedAt));
  assert.equal(kb.list().length, 15); assert.equal(kb.list({ recent: 2 }).length, 2);
  assert.equal(kb.list({ recent: 1 })[0].title, 'File 9');
  assert.equal(kb.get(999999), null);
});

test('KB prune deletes only stale notes and removes their FTS index entries', t => {
  const { kb, file } = fixture(t);
  file('old.py', 'old');
  kb.add({ kind: 'file', title: 'staleword', body: 'goneword', paths: ['old.py'] });
  const fresh = kb.add({ kind: 'fact', title: 'freshword', body: '' });
  file('old.py', 'changed');
  assert.throws(() => kb.prune({}), /stale/);
  assert.equal(kb.prune({ stale: true }), 1);
  assert.equal(kb.prune({ stale: true }), 0);
  assert.deepEqual(kb.search('goneword'), []);
  assert.equal(kb.stats().notes, 1); assert.equal(kb.get(fresh.id).stale, false);
});

test('KB enforces 2000-character bodies, validates inputs, and supports concurrent handles', t => {
  const f = fixture(t), kb = f.kb;
  const limit = kb.add({ kind: 'fact', title: 'Limit', body: 'é'.repeat(2000) });
  assert.equal(kb.get(limit.id).body.length, 2000);
  assert.throws(() => kb.add({ kind: 'fact', title: 'Limit', body: 'é'.repeat(2001) }), /2000/);
  assert.equal(kb.get(limit.id).body.length, 2000, 'failed upsert does not damage existing body');
  assert.throws(() => kb.add({ kind: 'bad', title: 'a', body: '' }), /kind/);
  assert.throws(() => kb.add({ kind: 'fact', title: ' ', body: '' }), /title/);
  assert.throws(() => kb.add({ kind: 'fact', title: 'a', body: '', paths: ['../outside'] }), /inside/);
  assert.throws(() => kb.add({ kind: 'fact', title: 'a', body: '', paths: [f.cwd] }), /inside/);
  for (const value of [-1, 0, 1.5, NaN]) {
    assert.throws(() => kb.search('Limit', { limit: value }), /integer/);
    assert.throws(() => kb.list({ recent: value }), /integer/);
  }
  const second = f.connect();
  second.add({ kind: 'fact', title: 'anotherword', body: '' });
  assert.equal(kb.search('anotherword').length, 1);
  assert.equal(second.stats().hits, 1);
});

test('KB canonical roots share memory across actual git worktrees but hash each searcher checkout', t => {
  const f = fixture(t, { open: false });
  const git = args => execFileSync('git', ['-C', f.cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  const worktree = join(f.dir, 'worktree');
  // No commits are necessary, even for the fixture repository.
  git(['worktree', 'add', '--orphan', '-b', 'kb-fixture', worktree]);
  mkdirSync(join(f.cwd, 'src')); mkdirSync(join(worktree, 'src'));
  f.file('src/core.py', 'same'); writeFileSync(join(worktree, 'src/core.py'), 'same');
  const alias = join(f.dir, 'alias'); symlinkSync(f.cwd, alias);
  assert.equal(projectRoot(alias), canonicalPath(f.cwd));
  assert.equal(projectRoot(join(worktree, 'src')), canonicalPath(f.cwd));
  assert.equal(kbPath(worktree), kbPath(f.cwd));
  assert.equal(kbPath(f.cwd), join(orchestraHome, 'kb', `${projectSlug(canonicalPath(f.cwd))}.sqlite`));
  const writer = f.connect({}, join(worktree, 'src'));
  const saved = writer.add({ kind: 'file', title: 'worktreeword', body: 'Shared module', paths: ['src/core.py'] });
  const reader = f.connect({}, f.cwd);
  assert.equal(reader.search('worktreeword')[0].stale, false);
  writeFileSync(join(worktree, 'src/core.py'), 'different');
  assert.equal(reader.search('worktreeword', { cwd: worktree })[0].stale, true);
  assert.equal(writer.search('worktreeword')[0].stale, true);
  assert.equal(reader.search('worktreeword')[0].stale, false);
  assert.equal(reader.get(saved.id).hits, 2);
  assert.equal(reader.prune({ stale: true, cwd: f.cwd }), 0);
  assert.equal(reader.prune({ stale: true, cwd: worktree }), 1);
  // CLI exercises the default db path and shared identity without any dbPath override.
  f.run(['add', '--kind', 'fact', '--title', 'sharedword', '--body', 'shared'], undefined, f.cwd);
  assert.equal(JSON.parse(f.run(['search', 'sharedword', '--json'], undefined, worktree)).length, 1);
});

test('KB CLI contract: stdin/body, upsert, compact output, filters, stale label and all commands', t => {
  const f = fixture(t, { open: false });
  f.file('tasklist/core.py', 'code');
  const add = ['add', '--kind', 'file', '--title', 'core.py: sort tasks', '--paths', 'tasklist/core.py',
    '--author', 'sonnet #2', '--task', '2'];
  assert.equal(f.run(add, 'sort_tasks(tasks) orders by due date'), '[1] added');
  const plain = f.run(['search', 'sort tasks']);
  assert.match(plain, /^\[1\] file · core\.py: sort tasks  \(tasklist\/core\.py\) · sonnet #2 · just now ✓\n     sort_tasks/);
  const json = JSON.parse(f.run(['search', 'sort tasks', '--limit', '1', '--kind', 'file', '--path', 'tasklist', '--json']));
  assert.equal(json[0].taskId, '2'); assert.equal(json[0].stale, false);
  assert.equal(f.run(['search', 'nonexistent']), 'Nothing found');
  assert.equal(f.run([...add, '--body', `sort_tasks ${'x'.repeat(500)}`]), '[1] updated');
  const long = f.run(['get', '1']).split('\n')[1].slice(5);
  assert.equal([...long].length, 300); assert.ok(long.endsWith('…'));
  f.file('tasklist/core.py', 'changed');
  assert.match(f.run(['search', 'sort tasks']), /stale\n/);
  assert.match(f.run(['list', '--recent', '1']), /\[1\].*stale/);
  f.run(['add', '--kind', 'context', '--title', 'About', '--body', 'Context']);
  assert.match(f.run(['context']), /About/);
  assert.equal(JSON.parse(f.run(['context', '--json']))[0].kind, 'context');
  const stats = JSON.parse(f.run(['stats', '--json']));
  assert.equal(stats.notes, 2); assert.equal(stats.hits, 2); assert.equal(stats.savedTokens, 400);
  assert.match(f.run(['stats']), /Notes: 2 · hits: 2 · ≈400 tokens saved/);
  assert.equal(f.run(['prune', '--stale']), 'Notes deleted: 1');
  assert.equal(f.cli(['get', '1']).status, 1);
});

test('KB CLI read-only fallback skips hit counting and reports errors in one English line', t => {
  const f = fixture(t, { open: false });
  f.run(['add', '--kind', 'fact', '--title', 'readonlyword', '--body', 'data']);
  chmodSync(join(f.home, 'kb'), 0o555);
  assert.equal(JSON.parse(f.run(['search', 'readonlyword', '--json']))[0].stale, false);
  assert.equal(JSON.parse(f.run(['stats', '--json'])).hits, 0);
  for (const args of [[], ['wat'], ['search'], ['search', 'x', '--limit', '-1'], ['prune'],
    ['add', '--kind', 'invalid', '--title', 'x', '--body', ''], ['list', '--json'], ['search', 'x', '--unknown']]) {
    const result = f.cli(args);
    assert.equal(result.status, 1, JSON.stringify(args)); assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error: [^\n]+\n$/); assert.doesNotMatch(result.stderr, /\p{Script=Cyrillic}/u);
    assert.doesNotMatch(result.stderr, /ExperimentalWarning| at file:/);
  }
  chmodSync(join(f.home, 'kb'), 0o700);
  const tooLong = f.cli(['add', '--kind', 'fact', '--title', 'x', '--body', 'x'.repeat(2001)]);
  assert.equal(tooLong.status, 1); assert.match(tooLong.stderr, /2000/);
});

test('KB searches 2000 matching notes in under 50 ms, including freshness and hit accounting', t => {
  const { kb, file } = fixture(t);
  file('src/core.py', 'source'.repeat(200));
  for (let i = 0; i < 2000; i++) kb.add({ kind: 'symbol', title: `Sort tasks ${i}`,
    body: `sort_tasks exportCsv tasklist.core ${i}`, paths: ['src/core.py'] });
  // Warm prepares and filesystem caches. Every query still ranks all 2000 matching notes.
  kb.search('sort tasks');
  const times = [];
  for (let i = 0; i < 7; i++) {
    const start = performance.now();
    const hits = kb.search('sort tasks');
    times.push(performance.now() - start);
    assert.equal(hits.length, 5); assert.ok(hits.every(hit => !hit.stale));
  }
  const median = [...times].sort((a, b) => a - b)[3];
  t.diagnostic(`2000 matches, fresh file refs, writable DB: median ${median.toFixed(2)} ms; max ${Math.max(...times).toFixed(2)} ms`);
  assert.ok(median < 50, `median search was ${median.toFixed(2)} ms`);
  assert.equal(kb.stats().hits, 40);
});
