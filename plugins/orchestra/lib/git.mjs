import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, appendFile, mkdir, rm, mkdtemp, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicJSON, boardPath } from './paths.mjs';

export class WorktreeError extends Error {
  constructor(message, files = []) {
    super(message + (files.length ? `\n${files.map(file => `  ${file}`).join('\n')}` : ''));
    this.exitCode = 2;
  }
}

// No shell: paths, ref names and commit messages remain individual arguments.
export function git(cwd, args, { env = {}, input } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = execFile('git', ['--literal-pathspecs', '-c', 'gc.auto=0', ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolveResult(stdout);
    });
    // execFile otherwise leaves stdin open; git apply reads its patch here.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const splitPaths = text => text.split('\0').filter(Boolean);
const tip = async (cwd, ref = 'HEAD') => (await git(cwd, ['rev-parse', '--verify', ref])).trim();
async function ancestor(cwd, older, newer) {
  try { await git(cwd, ['merge-base', '--is-ancestor', older, newer]); return true; }
  catch (error) { if (error.code === 1) return false; throw error; }
}
async function dirtyFiles(cwd) {
  const rows = splitPaths(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  const files = [];
  for (let at = 0; at < rows.length; at++) {
    const row = rows[at];
    files.push(row.slice(3));
    if (/[RC]/.test(row.slice(0, 2))) files.push(rows[++at]);
  }
  return [...new Set(files)].sort();
}
async function conflicts(cwd, env = {}) {
  return splitPaths(await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { env }));
}
async function requireClean(cwd, reason) {
  const files = await dirtyFiles(cwd);
  if (files.length) throw new WorktreeError(reason, files);
}
async function requireBranch(cwd, branch) {
  let actual;
  try { actual = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD'])).trim(); }
  catch (error) { if (error.code !== 1) throw error; actual = 'detached HEAD'; }
  if (actual !== `refs/heads/${branch}`) throw new WorktreeError(`Cannot continue: ${cwd} is on ${actual}, expected ${branch}`);
}

export async function repository(cwd) {
  const root = await realpath((await git(resolve(cwd), ['rev-parse', '--show-toplevel'])).trim());
  const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return { root, common, projectRoot: dirname(common) };
}

async function readState(projectRoot) {
  try { return JSON.parse(await readFile(join(projectRoot, '.orchestra/worktrees.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new WorktreeError('Cannot continue: worktrees are not initialized; run worktree init');
    throw error;
  }
}
async function board(cwd) {
  try { return JSON.parse(await readFile(boardPath(cwd), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function validId(id) {
  if (!id || !/^[\w-]+(?:\.[\w-]+)?$/.test(id) || id === 'main' || id === '_main') {
    throw new WorktreeError('Cannot select task: invalid id (main and _main are reserved; subtasks go one level deep)');
  }
}
function taskFor(state, id) {
  validId(id);
  const task = state.tasks.find(task => task.id === id);
  if (!task) throw new WorktreeError(`Cannot select #${id}: its worktree has not been created`);
  return task;
}
function sourceFor(state, task) {
  return task.from ? taskFor(state, task.from) : state.integration;
}

// Serialize CLI mutations across agents, including read-modify-write of the local registry.
async function withLock(common, operation) {
  const lock = join(common, 'orchestra-worktree.lock');
  const deadline = Date.now() + 15000;
  while (true) {
    try { await mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() > deadline) throw new WorktreeError(`Cannot run command: another command holds the lock ${lock}`);
      await new Promise(done => setTimeout(done, 50));
    }
  }
  try { return await operation(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

export async function runWorktree(command, { cwd = process.cwd(), id, from, into,
  allowDirty = false, stat = false, force = false, json = false,
  updateBoard = async () => {},
} = {}) {
  const repo = await repository(cwd);
  return withLock(repo.common, async () => {
    const statePath = join(repo.projectRoot, '.orchestra/worktrees.json');
    const save = state => atomicJSON(statePath, state);
    // Board writes are deliberately nonessential; the CLI callback emits a warning on failure.
    const updateIntegration = (state, fields = state.integration) => updateBoard(state.cwd, ['integration',
      // null is sent as an empty value: a re-init must clear the previous landedAt.
      ...Object.entries(fields).map(([key, value]) => `${key}=${value ?? ''}`)]);
    const updateTask = (state, task) => updateBoard(state.cwd, ['meta', task.id,
      `branch=${task.branch}`, `worktree=${task.worktree}`, `merged=${task.merged}`]);

    if (command === 'init') {
      const exclude = join(repo.common, 'info/exclude');
      await mkdir(dirname(exclude), { recursive: true });
      let excluded = '';
      try { excluded = await readFile(exclude, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // .omc/ is oh-my-claudecode runtime state its hooks write into every worktree; `accept`
      // stages with `git add --all`, so without this it would end up in the user's code.
      const missing = ['.orchestra/', '.omc/'].filter(entry => !excluded.split(/\r?\n/).includes(entry));
      if (missing.length) {
        await appendFile(exclude, `${excluded && !excluded.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
      }
      if (!allowDirty) await requireClean(repo.root, 'Cannot initialize worktrees: uncommitted changes in the working tree (use --allow-dirty):');
      let existing;
      try { existing = await readState(repo.projectRoot); }
      catch (error) { if (!(error instanceof WorktreeError)) throw error; }
      if (existing) {
        await requireBranch(existing.integration.worktree, existing.integration.branch);
        await updateIntegration(existing);
        return existing.integration.worktree;
      }
      const data = await board(repo.root);
      let userBranch;
      try { userBranch = (await git(repo.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim(); }
      catch { throw new WorktreeError('Cannot initialize worktrees: HEAD is detached; check out a branch first'); }
      const titleSlug = String(data.title || 'board').normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-|-$/g, '').slice(0, 32) || 'board';
      const slug = `${titleSlug}-${randomBytes(2).toString('hex')}`;
      const base = await tip(repo.root);
      const integration = { branch: `orchestra/${slug}/main`, worktree: join(repo.projectRoot, '.orchestra/worktrees/_main'), base, landedAt: null };
      await mkdir(dirname(integration.worktree), { recursive: true });
      await git(repo.root, ['worktree', 'add', '-b', integration.branch, integration.worktree, base]);
      const state = { version: 1, slug, cwd: repo.root, userBranch, integration, tasks: [] };
      await save(state);
      await updateIntegration(state);
      return integration.worktree;
    }

    const state = await readState(repo.projectRoot);
    if (command === 'create') {
      validId(id);
      const existing = state.tasks.find(task => task.id === id);
      if (existing) {
        if (from && existing.from !== from) throw new WorktreeError(`Cannot create #${id}: it was already created from another branch`);
        await requireBranch(existing.worktree, existing.branch);
        await updateTask(state, existing);
        return existing.worktree;
      }
      if (from) { validId(from); if (from.includes('.') || !id.startsWith(`${from}.`)) throw new WorktreeError(`Cannot create #${id}: --from must name the parent of the subtask`); }
      const source = from ? taskFor(state, from) : state.integration;
      const base = await tip(state.cwd, source.branch);
      const task = { id, from: from || null, branch: `orchestra/${state.slug}/${id}`, worktree: join(repo.projectRoot, '.orchestra/worktrees', id), base, merged: false };
      await git(state.cwd, ['worktree', 'add', '-b', task.branch, task.worktree, base]);
      state.tasks.push(task);
      await save(state);
      await updateTask(state, task);
      return task.worktree;
    }
    if (command === 'path') return taskFor(state, id).worktree;
    if (command === 'diff') {
      const task = taskFor(state, id);
      const temporary = await mkdtemp(join(tmpdir(), 'orchestra-index-'));
      const env = { GIT_INDEX_FILE: join(temporary, 'index') };
      try {
        // Build a snapshot without disturbing the agent's index or committing anything.
        await git(task.worktree, ['read-tree', 'HEAD'], { env });
        await git(task.worktree, ['add', '--all', '--', '.'], { env });
        return await git(task.worktree, ['diff', '--cached', '--no-ext-diff', '--no-textconv', ...(stat ? ['--stat'] : ['--binary']), task.base, '--'], { env });
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
    if (command === 'refresh' || command === 'accept') {
      const task = taskFor(state, id);
      await requireBranch(task.worktree, task.branch);
      const action = command === 'refresh' ? `Cannot refresh #${id}` : `Cannot merge #${id}`;
      const unresolved = await conflicts(task.worktree);
      if (unresolved.length) throw new WorktreeError(`${action}: unresolved conflicts in the worktree:`, unresolved);
      if (command === 'refresh') {
        await requireClean(task.worktree, `${action}: uncommitted changes in the worktree:`);
        try { await git(task.worktree, ['-c', 'commit.gpgSign=false', 'merge', '--no-edit', sourceFor(state, task).branch]); }
        catch (error) {
          const files = await conflicts(task.worktree);
          if (files.length) throw new WorktreeError(`${action}: conflict in files; resolve it in the worktree:`, files);
          throw error;
        }
        return `Task #${id} refreshed`;
      }
      if (into && (into.includes('.') || !id.startsWith(`${into}.`))) throw new WorktreeError(`${action}: --into must name the parent of the subtask`);
      const target = into ? taskFor(state, into) : state.integration;
      await requireBranch(target.worktree, target.branch);
      if (into) {
        const unresolvedParent = await conflicts(target.worktree);
        if (unresolvedParent.length) throw new WorktreeError(`${action}: unresolved conflicts in the worktree of parent #${into}:`, unresolvedParent);
        if ((await dirtyFiles(target.worktree)).length) {
          await git(target.worktree, ['add', '--all', '--', '.']);
          await git(target.worktree, ['-c', 'commit.gpgSign=false', 'commit', '-m', `#${into} wip before #${id}`]);
        }
      } else {
        await requireClean(target.worktree, `${action}: uncommitted changes in the integration worktree:`);
      }
      if ((await dirtyFiles(task.worktree)).length) {
        const data = await board(state.cwd);
        const title = data.tasks?.find(value => value.id === id)?.title || `Task ${id}`;
        await git(task.worktree, ['add', '--all', '--', '.']);
        await git(task.worktree, ['-c', 'commit.gpgSign=false', 'commit', '-m', `#${id} ${title}`]);
      }
      try { await git(target.worktree, ['-c', 'commit.gpgSign=false', 'merge', '--no-ff', '--no-edit', task.branch]); }
      catch (error) {
        const files = await conflicts(target.worktree);
        if (files.length) {
          await git(target.worktree, ['merge', '--abort']);
          throw new WorktreeError(`${action}: conflict in files; merge aborted:`, files);
        }
        throw error;
      }
      task.merged = true;
      task.into = into || null;
      state.integration.landedAt = null;
      await save(state);
      await updateTask(state, task);
      return `Task #${id} merged into ${target.branch}`;
    }
    if (command === 'land') {
      await requireBranch(state.cwd, state.userBranch);
      await requireBranch(state.integration.worktree, state.integration.branch);
      await requireClean(state.integration.worktree, 'Cannot land: uncommitted changes in the integration worktree:');
      const base = (await git(state.cwd, ['merge-base', 'HEAD', state.integration.branch])).trim();
      const touched = splitPaths(await git(state.cwd, ['diff', '--name-only', '--no-renames', '-z', base, state.integration.branch]));
      const dirty = await dirtyFiles(state.cwd);
      // Git can silently overwrite ignored files during a merge. They are still the
      // user's data, so include ignored files within the merge's affected paths.
      if (touched.length) dirty.push(...splitPaths(await git(state.cwd,
        ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...touched])));
      const overlaps = dirty.filter(file => touched.some(path => path === file || path.startsWith(`${file}/`) || file.startsWith(`${path}/`)));
      if (overlaps.length) throw new WorktreeError('Cannot land: your working tree has uncommitted changes in files the merge touches:', overlaps);
      // Detect textual conflicts before modifying the user's worktree. merge-tree creates
      // only git objects; it never changes an index, branch, or working file.
      try { await git(state.cwd, ['merge-tree', '--write-tree', '--name-only', '-z', 'HEAD', state.integration.branch]); }
      catch (error) {
        if (error.code === 1) {
          const fields = error.stdout.split('\0').slice(1);
          const files = fields.slice(0, fields.indexOf(''));
          throw new WorktreeError('Cannot land: conflict in files:', files);
        }
        throw error;
      }
      const temporary = await mkdtemp(join(tmpdir(), 'orchestra-land-'));
      const env = { GIT_INDEX_FILE: join(temporary, 'index') };
      try {
        // Squash in a temporary index, preserving unrelated staged edits in the real one.
        await git(state.cwd, ['read-tree', 'HEAD'], { env });
        await git(state.cwd, ['merge', '--squash', state.integration.branch], { env });
        const patch = await git(state.cwd, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], { env });
        if (patch) await git(state.cwd, ['apply', '--cached', '--binary', '--whitespace=nowarn'], { input: patch });
      } finally { await rm(temporary, { recursive: true, force: true }); }
      state.integration.landedAt = new Date().toISOString();
      await save(state);
      await updateIntegration(state, { landedAt: state.integration.landedAt });
      return 'Changes landed and staged; no commit created';
    }
    if (command === 'status') {
      const tasks = [];
      for (const task of state.tasks) {
        const source = sourceFor(state, task);
        const counts = (await git(state.cwd, ['rev-list', '--left-right', '--count', `${source.branch}...${task.branch}`])).trim().split(/\s+/).map(Number);
        const dirty = await dirtyFiles(task.worktree);
        const target = task.into ? taskFor(state, task.into) : state.integration;
        tasks.push({ ...task, behind: counts[0], ahead: counts[1], dirty: dirty.length > 0, dirtyFiles: dirty,
          merged: task.merged && dirty.length === 0 && await ancestor(state.cwd, task.branch, target.branch) });
      }
      const result = { integration: state.integration, tasks };
      return json ? JSON.stringify(result) : [`Integration: ${state.integration.branch}`, ...tasks.map(task =>
        `#${task.id} ${task.branch} ${task.worktree} +${task.ahead}/-${task.behind}${task.dirty ? ' · uncommitted changes' : ''}${task.merged ? ' · merged' : ''}`)].join('\n');
    }
    if (command === 'cleanup') {
      if (!force) {
        for (const task of state.tasks) {
          await requireBranch(task.worktree, task.branch);
          await requireClean(task.worktree, `Cannot remove worktree #${task.id}: uncommitted changes in the worktree:`);
          if (!await ancestor(state.cwd, task.branch, state.integration.branch)) throw new WorktreeError(`Cannot remove worktree #${task.id}: the task is not merged into the integration branch; use --force`);
        }
        await requireBranch(state.integration.worktree, state.integration.branch);
        await requireClean(state.integration.worktree, 'Cannot remove the integration worktree: uncommitted changes in the worktree:');
      }
      for (const task of [...state.tasks, state.integration]) {
        await git(state.cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), task.worktree]);
        // -D is safe after the explicit ancestry check above (the user's HEAD is not the target).
        await git(state.cwd, ['branch', '-D', task.branch]);
      }
      await rm(statePath);
      return 'Worktrees and branches removed';
    }
    throw new WorktreeError('Cannot run command: unknown worktree command');
  });
}
