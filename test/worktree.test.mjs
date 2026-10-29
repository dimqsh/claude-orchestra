import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, realpath, access, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../plugins/orchestra/scripts/worktree.mjs', import.meta.url));

async function fixture(t, { boardFails = false } = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'orchestra worktree ')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cwd = join(temp, 'user project');
  await mkdir(cwd);
  const env = { ...process.env, HOME: join(temp, 'home'), XDG_CONFIG_HOME: join(temp, 'config'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(temp, 'no-global-config'),
    GIT_AUTHOR_NAME: 'Worktree Test', GIT_AUTHOR_EMAIL: 'author@example.invalid',
    GIT_COMMITTER_NAME: 'Worktree Test', GIT_COMMITTER_EMAIL: 'committer@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    ORCHESTRA_HOME: join(temp, 'orchestra home'), CLAUDE_CONFIG_DIR: join(temp, 'claude home'),
    ORCHESTRA_BOARD_BIN: join(temp, 'board recorder.mjs'), ORCHESTRA_BOARD_LOG: join(temp, 'board calls.jsonl') };
  // Never inherit an outer git invocation's repository/index overrides.
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  const run = async (bin, args, dir = cwd) => {
    try { return { code: 0, ...await execute(bin, args, { cwd: dir, env, maxBuffer: 8 * 1024 * 1024 }) }; }
    catch (error) { return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' }; }
  };
  const git = async (args, dir = cwd) => {
    const result = await run('git', args, dir);
    assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const cli = (...args) => run(process.execPath, [script, '--cwd', cwd, ...args]);
  const ok = async (...args) => {
    const result = await cli(...args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await writeFile(env.ORCHESTRA_BOARD_BIN, `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.ORCHESTRA_BOARD_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
${boardFails ? "console.error('recorder unavailable\\nsecond line'); process.exitCode = 1;" : ''}
`);
  await git(['init', '-b', 'user']);
  await writeFile(join(cwd, 'shared file.txt'), 'base\n');
  await writeFile(join(cwd, 'untouched.txt'), 'original\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'fixture base']);
  const base = await git(['rev-parse', 'HEAD']);
  const boards = join(env.ORCHESTRA_HOME, 'boards');
  await mkdir(boards, { recursive: true });
  await writeFile(join(boards, `${cwd.replace(/[^a-zA-Z0-9]/g, '-')}.json`), JSON.stringify({ title: 'Feature board', tasks: [
    { id: '1', title: 'First task' }, { id: '2', title: 'Parent task' }, { id: '2.1', title: 'Child task' },
  ] }));
  const state = async () => JSON.parse(await readFile(join(cwd, '.orchestra/worktrees.json'), 'utf8'));
  const calls = async () => (await readFile(env.ORCHESTRA_BOARD_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  return { temp, cwd, env, base, git, cli, ok, state, calls, run };
}

test('init lists dirty files with exit 2, allows opt-in, and excludes .orchestra only once', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'shared file.txt'), 'local edits\n');
  await writeFile(join(f.cwd, 'untracked file.txt'), 'new\n');
  const refused = await f.cli('init');
  assert.equal(refused.code, 2);
  assert.match(refused.stderr.split('\n')[0], /^Error: Cannot initialize worktrees: uncommitted changes/);
  assert.match(refused.stderr, /shared file\.txt/);
  assert.match(refused.stderr, /untracked file\.txt/);
  await assert.rejects(access(join(f.cwd, '.orchestra/worktrees/_main')));
  const integrationPath = await f.ok('init', '--allow-dirty');
  assert.equal(await readFile(join(integrationPath, 'shared file.txt'), 'utf8'), 'base\n');
  assert.equal(await f.ok('init', '--allow-dirty'), integrationPath);
  const state = await f.state();
  assert.match(state.integration.branch, /^orchestra\/Feature-board-[a-f0-9]{4}\/main$/);
  assert.equal(state.integration.base, f.base);
  assert.equal((await readFile(join(f.cwd, '.git/info/exclude'), 'utf8')).split('\n').filter(line => line === '.orchestra/').length, 1);
  await assert.rejects(access(join(f.cwd, '.gitignore')));
  assert.equal(await f.git(['rev-parse', 'HEAD']), f.base);
  assert.equal((await f.calls()).filter(call => call[2] === 'integration').length, 2);
});

test('init notices index changes even when the working file has been restored to HEAD', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'shared file.txt'), 'staged\n');
  await f.git(['add', '.']);
  await writeFile(join(f.cwd, 'shared file.txt'), 'base\n');
  const result = await f.cli('init');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /shared file\.txt/);
});

test('create is idempotent, records board metadata, and --from uses the parent tip', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const parent = await f.ok('create', '2');
  assert.equal(await f.ok('create', '2'), parent);
  assert.equal(await f.ok('path', '2'), parent);
  await writeFile(join(parent, 'parent.txt'), 'parent commit\n');
  await f.git(['add', '.'], parent);
  await f.git(['commit', '-m', 'parent work'], parent);
  const child = await f.ok('create', '2.1', '--from', '2');
  assert.equal(await readFile(join(child, 'parent.txt'), 'utf8'), 'parent commit\n');
  const state = await f.state();
  assert.equal(state.tasks[1].base, await f.git(['rev-parse', 'HEAD'], parent));
  assert.equal(state.tasks[1].from, '2');
  assert.equal(state.tasks.length, 2);
  assert((await f.calls()).some(call => call[2] === 'meta' && call[3] === '2.1' && call.includes(`worktree=${child}`) && call.includes('merged=false')));
  assert.equal((await f.cli('create', '2.1.1', '--from', '2.1')).code, 2);
  assert.equal((await f.cli('create', '../escape')).code, 2);
});

test('simultaneous task creation preserves both registry entries', async t => {
  const f = await fixture(t);
  await f.ok('init');
  await Promise.all([f.ok('create', '1'), f.ok('create', '2')]);
  assert.deepEqual((await f.state()).tasks.map(task => task.id).sort(), ['1', '2']);
});

test('diff combines committed, staged, unstaged and untracked content without changing the index', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'committed.txt'), 'committed content\n');
  await f.git(['add', '.'], task);
  await f.git(['commit', '-m', 'agent checkpoint'], task);
  await writeFile(join(task, 'staged.txt'), 'staged content\n');
  await f.git(['add', '.'], task);
  await writeFile(join(task, 'shared file.txt'), 'unstaged content\n');
  await writeFile(join(task, 'new file.txt'), 'untracked content\n');
  await writeFile(join(task, 'binary.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const before = await f.git(['status', '--porcelain'], task);
  const head = await f.git(['rev-parse', 'HEAD'], task);
  const diff = await f.ok('diff', '1');
  for (const content of ['committed content', 'staged content', 'unstaged content', 'untracked content', 'GIT binary patch']) assert(diff.includes(content), content);
  assert.match(await f.ok('diff', '1', '--stat'), /new file\.txt/);
  assert.equal(await f.git(['status', '--porcelain'], task), before);
  assert.equal(await f.git(['rev-parse', 'HEAD'], task), head);
});

test('accept commits on the task branch, makes a no-ff integration merge, and updates the board', async t => {
  const f = await fixture(t);
  const integration = await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'new file.txt'), 'accepted\n');
  await f.ok('accept', '1');
  const taskTip = await f.git(['rev-parse', 'HEAD'], task);
  assert.equal(await f.git(['log', '-1', '--format=%s'], task), '#1 First task');
  assert.deepEqual((await f.git(['rev-list', '--parents', '-n', '1', 'HEAD'], integration)).split(' ').slice(1), [f.base, taskTip]);
  assert.equal(await f.git(['rev-parse', 'HEAD']), f.base);
  assert.equal(await f.git(['status', '--porcelain']), '');
  assert.equal(await readFile(join(integration, 'new file.txt'), 'utf8'), 'accepted\n');
  assert((await f.calls()).some(call => call[2] === 'meta' && call[3] === '1' && call.includes('merged=true')));
  const status = JSON.parse(await f.ok('status', '--json'));
  assert.equal(status.tasks[0].merged, true);
  assert.equal(status.tasks[0].dirty, false);
  assert.equal(status.tasks[0].ahead, 0);
  assert.equal(status.tasks[0].behind, 1);
  assert.match(await f.ok('status'), / · merged/);
});

test('accept aborts a conflicting merge, lists files and preserves the integration tip', async t => {
  const f = await fixture(t);
  const integration = await f.ok('init');
  const one = await f.ok('create', '1');
  const two = await f.ok('create', '2');
  await writeFile(join(one, 'shared file.txt'), 'first\n');
  await f.ok('accept', '1');
  const before = await f.git(['rev-parse', 'HEAD'], integration);
  await writeFile(join(two, 'shared file.txt'), 'second\n');
  const result = await f.cli('accept', '2');
  assert.equal(result.code, 2);
  assert.equal(result.stderr.split('\n')[0], 'Error: Cannot merge #2: conflict in files; merge aborted:');
  assert.match(result.stderr, /shared file\.txt/);
  assert.equal(await f.git(['rev-parse', 'HEAD'], integration), before);
  assert.equal(await f.git(['status', '--porcelain'], integration), '');
  assert.equal(await readFile(join(integration, 'shared file.txt'), 'utf8'), 'first\n');
  assert.equal(await f.git(['log', '-1', '--format=%s'], two), '#2 Parent task');
  assert.equal((await f.run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], integration)).code, 128);
  assert(!(await f.calls()).some(call => call[2] === 'meta' && call[3] === '2' && call.includes('merged=true')));
});

test('subtask accepts into its parent, then the parent accepts into integration', async t => {
  const f = await fixture(t);
  const integration = await f.ok('init');
  const parent = await f.ok('create', '2');
  const child = await f.ok('create', '2.1', '--from', '2');
  await writeFile(join(child, 'child.txt'), 'child work\n');
  await f.ok('accept', '2.1', '--into', '2');
  assert.equal(await readFile(join(parent, 'child.txt'), 'utf8'), 'child work\n');
  assert.equal(await f.git(['rev-parse', 'HEAD'], integration), f.base);
  assert.equal(JSON.parse(await f.ok('status', '--json')).tasks.find(task => task.id === '2.1').merged, true);
  assert.equal((await f.cli('cleanup')).code, 2);
  await f.ok('accept', '2');
  assert.equal(await readFile(join(integration, 'child.txt'), 'utf8'), 'child work\n');
});

test('accept checkpoints dirty parent work before merging its subtask and lands all files staged', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, 'b.txt'), 'parent base\n');
  await f.git(['add', 'b.txt']);
  await f.git(['commit', '-m', 'parent fixture']);
  const userTip = await f.git(['rev-parse', 'HEAD']);
  const integration = await f.ok('init');
  const parent = await f.ok('create', '2');
  const child = await f.ok('create', '2.1', '--from', '2');
  await writeFile(join(child, 'child.txt'), 'child work\n');
  await writeFile(join(parent, 'b.txt'), 'parent unfinished edits\n');
  await writeFile(join(parent, 'new.txt'), 'parent untracked work\n');
  await writeFile(join(parent, 'staged.txt'), 'parent staged work\n');
  await f.git(['add', 'staged.txt'], parent);

  await f.ok('accept', '2.1', '--into', '2');
  const childTip = await f.git(['rev-parse', 'HEAD'], child);
  const wipTip = await f.git(['rev-parse', 'HEAD^1'], parent);
  assert.equal(await f.git(['show', '-s', '--format=%s', wipTip], parent), '#2 wip before #2.1');
  assert.equal(await f.git(['rev-parse', `${wipTip}^`], parent), userTip);
  assert.deepEqual((await f.git(['rev-list', '--parents', '-n', '1', 'HEAD'], parent)).split(' ').slice(1), [wipTip, childTip]);
  assert.equal(await f.git(['show', `${wipTip}:b.txt`], parent), 'parent unfinished edits');
  assert.equal(await f.git(['show', `${wipTip}:new.txt`], parent), 'parent untracked work');
  assert.equal(await f.git(['status', '--porcelain'], parent), '');
  assert.equal(await f.git(['rev-parse', 'HEAD'], integration), userTip);
  assert.equal(JSON.parse(await f.ok('status', '--json')).tasks.find(task => task.id === '2.1').merged, true);

  await f.ok('accept', '2');
  await f.ok('land');
  for (const [file, content] of [['b.txt', 'parent unfinished edits'], ['new.txt', 'parent untracked work'],
    ['staged.txt', 'parent staged work'], ['child.txt', 'child work']]) {
    assert.equal(await f.git(['show', `:${file}`]), content);
    assert.equal(await readFile(join(f.cwd, file), 'utf8'), `${content}\n`);
  }
  assert.equal(await f.git(['rev-parse', 'HEAD']), userTip);
  assert.equal(await f.git(['diff']), '');
  assert.deepEqual((await f.git(['diff', '--cached', '--name-only'])).split('\n'), ['b.txt', 'child.txt', 'new.txt', 'staged.txt']);
});

test('accept aborts a subtask conflict while preserving the parent WIP commit and every parent file', async t => {
  const f = await fixture(t);
  const integration = await f.ok('init');
  const parent = await f.ok('create', '2');
  const child = await f.ok('create', '2.1', '--from', '2');
  await writeFile(join(parent, 'shared file.txt'), 'parent unfinished edits\n');
  await writeFile(join(parent, 'new.txt'), 'parent untracked work\n');
  await writeFile(join(child, 'shared file.txt'), 'child conflicting work\n');
  const result = await f.cli('accept', '2.1', '--into', '2');
  assert.equal(result.code, 2);
  assert.deepEqual(result.stderr.trimEnd().split('\n'), [
    'Error: Cannot merge #2.1: conflict in files; merge aborted:', '  shared file.txt',
  ]);
  assert.equal(await f.git(['log', '-1', '--format=%s'], parent), '#2 wip before #2.1');
  assert.equal(await f.git(['rev-parse', 'HEAD^'], parent), f.base);
  assert.equal(await f.git(['show', 'HEAD:shared file.txt'], parent), 'parent unfinished edits');
  assert.equal(await f.git(['show', 'HEAD:new.txt'], parent), 'parent untracked work');
  assert.equal(await readFile(join(parent, 'shared file.txt'), 'utf8'), 'parent unfinished edits\n');
  assert.equal(await readFile(join(parent, 'new.txt'), 'utf8'), 'parent untracked work\n');
  assert.equal(await f.git(['status', '--porcelain'], parent), '');
  assert.equal((await f.run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], parent)).code, 128);
  assert.equal(await f.git(['rev-parse', 'HEAD'], integration), f.base);
  assert.equal(JSON.parse(await f.ok('status', '--json')).tasks.find(task => task.id === '2.1').merged, false);
});

test('accept refuses unresolved parent conflicts instead of checkpointing conflict markers', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const parent = await f.ok('create', '2');
  const child = await f.ok('create', '2.1', '--from', '2');
  await writeFile(join(parent, 'shared file.txt'), 'parent work\n');
  await f.git(['add', '.'], parent);
  await f.git(['commit', '-m', 'parent checkpoint'], parent);
  await writeFile(join(child, 'shared file.txt'), 'child work\n');
  await f.git(['add', '.'], child);
  await f.git(['commit', '-m', 'child checkpoint'], child);
  const childBranch = (await f.state()).tasks.find(task => task.id === '2.1').branch;
  const conflict = await f.run('git', ['merge', '--no-edit', childBranch], parent);
  assert.equal(conflict.code, 1);
  const beforeTip = await f.git(['rev-parse', 'HEAD'], parent);
  const beforeFile = await readFile(join(parent, 'shared file.txt'), 'utf8');
  const beforeIndex = await f.git(['ls-files', '--stage'], parent);
  const result = await f.cli('accept', '2.1', '--into', '2');
  assert.equal(result.code, 2);
  assert.deepEqual(result.stderr.trimEnd().split('\n'), [
    'Error: Cannot merge #2.1: unresolved conflicts in the worktree of parent #2:', '  shared file.txt',
  ]);
  assert.equal(await f.git(['rev-parse', 'HEAD'], parent), beforeTip);
  assert.equal(await readFile(join(parent, 'shared file.txt'), 'utf8'), beforeFile);
  assert.equal(await f.git(['ls-files', '--stage'], parent), beforeIndex);
});

test('accept still refuses a dirty integration worktree with an actionable reason', async t => {
  const f = await fixture(t);
  const integration = await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(integration, 'integration.txt'), 'reviewer unfinished work\n');
  await writeFile(join(task, 'child.txt'), 'task work\n');
  const result = await f.cli('accept', '1');
  assert.equal(result.code, 2);
  assert.deepEqual(result.stderr.trimEnd().split('\n'), [
    'Error: Cannot merge #1: uncommitted changes in the integration worktree:', '  integration.txt',
  ]);
  assert.equal(await f.git(['rev-parse', 'HEAD'], task), f.base);
  assert.equal(await readFile(join(integration, 'integration.txt'), 'utf8'), 'reviewer unfinished work\n');
});

test('refresh merges integration and --from parent tips', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const one = await f.ok('create', '1');
  const parent = await f.ok('create', '2');
  const child = await f.ok('create', '2.1', '--from', '2');
  await writeFile(join(one, 'accepted.txt'), 'integration\n');
  await f.ok('accept', '1');
  await f.ok('refresh', '2');
  assert.equal(await readFile(join(parent, 'accepted.txt'), 'utf8'), 'integration\n');
  await f.ok('refresh', '2.1');
  assert.equal(await readFile(join(child, 'accepted.txt'), 'utf8'), 'integration\n');
});

test('refresh conflicts remain in the task worktree with exit 2 and a file list', async t => {
  const f = await fixture(t);
  const integration = await f.ok('init');
  const one = await f.ok('create', '1');
  const two = await f.ok('create', '2');
  await writeFile(join(one, 'shared file.txt'), 'first\n');
  await f.ok('accept', '1');
  await writeFile(join(two, 'shared file.txt'), 'second\n');
  await f.git(['add', '.'], two);
  await f.git(['commit', '-m', 'local checkpoint'], two);
  const tip = await f.git(['rev-parse', 'HEAD'], integration);
  const result = await f.cli('refresh', '2');
  assert.equal(result.code, 2);
  assert.equal(result.stderr.split('\n')[0], 'Error: Cannot refresh #2: conflict in files; resolve it in the worktree:');
  assert.match(result.stderr, /shared file\.txt/);
  assert.match(await readFile(join(two, 'shared file.txt'), 'utf8'), /<<<<<<</);
  assert.equal(await f.git(['diff', '--name-only', '--diff-filter=U'], two), 'shared file.txt');
  assert.equal(await f.git(['rev-parse', 'HEAD'], integration), tip);
  assert.equal((await f.cli('accept', '2')).code, 2);
});

test('land squashes and stages without a user commit, preserves unrelated staged and unstaged work', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'shared file.txt'), 'landed\n');
  await writeFile(join(task, 'new file.txt'), 'new\n');
  await f.ok('accept', '1');
  await writeFile(join(f.cwd, 'untouched.txt'), 'staged unrelated\n');
  await f.git(['add', 'untouched.txt']);
  await appendFile(join(f.cwd, 'untouched.txt'), 'unstaged unrelated\n');
  const beforeIndex = await f.git(['show', ':untouched.txt']);
  const beforeWorktree = await readFile(join(f.cwd, 'untouched.txt'), 'utf8');
  await f.ok('land');
  assert.equal(await f.git(['rev-parse', 'HEAD']), f.base);
  assert.equal(await f.git(['show', ':shared file.txt']), 'landed');
  assert.equal(await f.git(['show', ':new file.txt']), 'new');
  assert.equal(await f.git(['show', ':untouched.txt']), beforeIndex);
  assert.equal(await readFile(join(f.cwd, 'untouched.txt'), 'utf8'), beforeWorktree);
  assert.equal(await f.git(['rev-list', '--count', 'HEAD']), '1');
  assert.match((await f.state()).integration.landedAt, /^\d{4}-/);
  assert((await f.calls()).some(call => call[2] === 'integration' && call.some(value => value.startsWith('landedAt='))));
  assert.equal((await f.run('git', ['rev-parse', '--verify', 'MERGE_HEAD'])).code, 128);
});

test('land refuses touched tracked or untracked user files and preserves them', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'shared file.txt'), 'agent\n');
  await writeFile(join(task, 'new file.txt'), 'agent new\n');
  await f.ok('accept', '1');
  await writeFile(join(f.cwd, 'shared file.txt'), 'user\n');
  await writeFile(join(f.cwd, 'new file.txt'), 'user new\n');
  const result = await f.cli('land');
  assert.equal(result.code, 2);
  assert.equal(result.stderr.split('\n')[0], 'Error: Cannot land: your working tree has uncommitted changes in files the merge touches:');
  assert.match(result.stderr, /shared file\.txt/);
  assert.match(result.stderr, /new file\.txt/);
  assert.equal(await readFile(join(f.cwd, 'shared file.txt'), 'utf8'), 'user\n');
  assert.equal(await readFile(join(f.cwd, 'new file.txt'), 'utf8'), 'user new\n');
  assert.equal(await f.git(['diff', '--cached']), '');
  assert.equal((await f.state()).integration.landedAt, null);
});

test('land refuses a divergent conflicting user commit before changing files or index', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'shared file.txt'), 'agent\n');
  await f.ok('accept', '1');
  await writeFile(join(f.cwd, 'shared file.txt'), 'user commit\n');
  await f.git(['add', '.']);
  await f.git(['commit', '-m', 'user work']);
  const before = await f.git(['rev-parse', 'HEAD']);
  const result = await f.cli('land');
  assert.equal(result.code, 2);
  assert.deepEqual(result.stderr.trimEnd().split('\n'), ['Error: Cannot land: conflict in files:', '  shared file.txt']);
  assert.match(result.stderr, /shared file\.txt/);
  assert.equal(await readFile(join(f.cwd, 'shared file.txt'), 'utf8'), 'user commit\n');
  assert.equal(await f.git(['status', '--porcelain']), '');
  assert.equal(await f.git(['rev-parse', 'HEAD']), before);
});

test('land preserves ignored user files that git merge would otherwise overwrite', async t => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, '.gitignore'), 'ignored.txt\n');
  await f.git(['add', '.gitignore']);
  await f.git(['commit', '-m', 'ignore generated data']);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'ignored.txt'), 'agent tracked content\n');
  await f.git(['add', '-f', 'ignored.txt'], task);
  await f.git(['commit', '-m', 'track generated artifact'], task);
  await f.ok('accept', '1');
  await writeFile(join(f.cwd, 'ignored.txt'), 'user ignored content\n');
  const result = await f.cli('land');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /ignored\.txt/);
  assert.equal(await readFile(join(f.cwd, 'ignored.txt'), 'utf8'), 'user ignored content\n');
  assert.equal(await f.git(['diff', '--cached']), '');
});

test('land stages renamed, deleted and binary files, including literal pathspec characters', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await rename(join(task, 'shared file.txt'), join(task, 'renamed [file].txt'));
  await rm(join(task, 'untouched.txt'));
  const binary = Buffer.from([0, 23, 255, 0, 12]);
  await writeFile(join(task, 'binary.bin'), binary);
  await f.ok('accept', '1');
  await f.ok('land');
  assert.equal(await f.git(['show', ':renamed [file].txt']), 'base');
  assert.deepEqual(await readFile(join(f.cwd, 'binary.bin')), binary);
  await assert.rejects(access(join(f.cwd, 'untouched.txt')));
  await assert.rejects(access(join(f.cwd, 'shared file.txt')));
  assert.match(await f.git(['diff', '--cached', '--summary']), /delete mode.*untouched\.txt/);
  assert.equal(await f.git(['rev-parse', 'HEAD']), f.base);
});

test('cleanup refuses unmerged or dirty task work and --force removes worktrees and branches', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'unmerged.txt'), 'unfinished\n');
  assert.equal((await f.cli('cleanup')).code, 2);
  await f.git(['add', '.'], task);
  await f.git(['commit', '-m', 'not reviewed'], task);
  assert.equal((await f.cli('cleanup')).code, 2);
  assert.equal((await f.git(['worktree', 'list', '--porcelain'])).split('\n').filter(line => line.startsWith('worktree ')).length, 3);
  await f.ok('cleanup', '--force');
  assert.equal((await f.git(['worktree', 'list', '--porcelain'])).split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  assert.equal(await f.git(['branch', '--list', 'orchestra/*']), '');
  assert.equal(await f.git(['rev-parse', 'HEAD']), f.base);
  await assert.rejects(access(task));
  await assert.rejects(access(join(f.cwd, '.orchestra/worktrees.json')));
});

test('cleanup accepts integrated clean tasks and preserves staged landing', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'new.txt'), 'done\n');
  await f.ok('accept', '1');
  await f.ok('land');
  await f.ok('cleanup');
  assert.equal(await f.git(['show', ':new.txt']), 'done');
  assert.equal(await f.git(['rev-parse', 'HEAD']), f.base);
});

test('board failures print one warning line and do not stop init, create, accept or land', async t => {
  const f = await fixture(t, { boardFails: true });
  for (const args of [['init'], ['create', '1']]) {
    const result = await f.cli(...args);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim().split('\n').length, 1);
    assert.match(result.stderr, /Warning/);
  }
  const task = await f.ok('path', '1');
  await writeFile(join(task, 'new.txt'), 'done\n');
  for (const command of ['accept', 'land']) {
    const result = await f.cli(command, ...(command === 'accept' ? ['1'] : []));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr.trim().split('\n').length, 1);
  }
  assert.equal(await f.git(['show', ':new.txt']), 'done');
  assert.equal((await f.calls()).length, 4);
});

test('commands from a task worktree use the shared registry and update the original board cwd', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  const result = await f.run(process.execPath, [script, '--cwd', task, 'create', '2']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(f.cwd, '.orchestra/worktrees/2'));
  assert.equal((await f.calls()).at(-1)[1], f.cwd);
});

test('status --json reports dirty state and ahead/behind using real git ancestry', async t => {
  const f = await fixture(t);
  await f.ok('init');
  const task = await f.ok('create', '1');
  await writeFile(join(task, 'changed.txt'), 'checkpoint\n');
  await f.git(['add', '.'], task);
  await f.git(['commit', '-m', 'checkpoint'], task);
  await rename(join(task, 'shared file.txt'), join(task, 'renamed file.txt'));
  await f.git(['add', '.'], task);
  const result = JSON.parse(await f.ok('status', '--json'));
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].ahead, 1);
  assert.equal(result.tasks[0].behind, 0);
  assert.equal(result.tasks[0].dirty, true);
  assert.equal(result.tasks[0].merged, false);
  assert.deepEqual(result.tasks[0].dirtyFiles, ['renamed file.txt', 'shared file.txt']);
});
