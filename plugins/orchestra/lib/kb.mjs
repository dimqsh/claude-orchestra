import { accessSync, constants, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { orchestraHome, projectSlug, canonicalPath } from './paths.mjs';

const kinds = new Set(['context', 'file', 'symbol', 'fact', 'command', 'gotcha', 'decision']);
let DatabaseSync;

function databaseClass() {
  if (DatabaseSync) return DatabaseSync;
  // Suppress only this builtin's warning, only while loading it (Node 22).
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = function (warning, type, ...rest) {
      if ((type === 'ExperimentalWarning' || type?.type === 'ExperimentalWarning' ||
          warning?.name === 'ExperimentalWarning') && /SQLite/i.test(warning?.message || warning)) return;
      return emitWarning.call(this, warning, type, ...rest);
    };
    try {
      ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
    } catch {
      throw new Error(`Shared memory needs Node 22.13 or newer (built-in node:sqlite), found ${process.version}`);
    }
  } finally { process.emitWarning = emitWarning; }
  return DatabaseSync;
}

function gitPath(cwd, flag) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', flag],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch { return null; }
}

export function projectRoot(cwd) {
  cwd = canonicalPath(cwd);
  const common = gitPath(cwd, '--git-common-dir');
  return common ? canonicalPath(dirname(common)) : cwd;
}

export function kbPath(cwd) {
  return join(orchestraHome, 'kb', `${projectSlug(projectRoot(cwd))}.sqlite`);
}

function repoRoot(cwd) {
  cwd = canonicalPath(cwd);
  return canonicalPath(gitPath(cwd, '--show-toplevel') || cwd);
}

function splitIdentifiers(text) {
  return text.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/[_./-]+/g, ' ');
}

function terms(text) {
  return `${text.toLowerCase()} ${splitIdentifiers(text).toLowerCase()}`;
}

function matchQuery(query) {
  if (typeof query !== 'string') throw new Error('Provide a search query');
  const words = [...new Set(splitIdentifiers(query).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
  // Never interpolate FTS operators from user input. Terms are OR-ed (BM25 still ranks notes
  // matching more terms first) and matched as prefixes of a crude stem (Russian words lose
  // their last one or two letters), so one word form finds its other forms. Agents phrase
  // the same thing differently.
  return words.map(word => {
    let stem = word;
    if (/\p{Script=Cyrillic}/u.test(word)) stem = word.length >= 6 ? word.slice(0, -2) : word.length === 5 ? word.slice(0, -1) : word;
    else if (word.length >= 5 && word.endsWith('s')) stem = word.slice(0, -1);
    return stem.length >= 3 ? `"${stem}"*` : `"${stem}"`;
  }).join(' OR ');
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name}: must be a positive integer`);
  return value;
}

function normalizePaths(paths, root) {
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || !path || path.includes('\0'))) {
    throw new Error('Paths must be an array of relative file names');
  }
  return [...new Set(paths.map(path => {
    const normalized = relative(root, resolve(root, path));
    if (isAbsolute(path) || !normalized || normalized === '..' || normalized.startsWith(`..${sep}`)) {
      throw new Error('Provide file paths inside the project');
    }
    return normalized.split(sep).join('/');
  }))].sort();
}

function fileInfo(root, path, cache) {
  if (!cache.has(path)) {
    try {
      const body = readFileSync(resolve(root, path));
      cache.set(path, { hash: createHash('sha1').update(body).digest('hex'), size: body.length });
    } catch { cache.set(path, { hash: null, size: 0 }); }
  }
  return cache.get(path);
}

function staleRow(row, root, cache) {
  return Object.entries(JSON.parse(row.refs)).some(([path, hash]) =>
    !hash || fileInfo(root, path, cache).hash !== hash);
}

function note(row, stale, score = 0) {
  return { id: row.id, kind: row.kind, title: row.title, body: row.body,
    paths: JSON.parse(row.paths), author: row.author, taskId: row.task_id,
    updatedAt: row.updated_at, stale, score };
}

function writable(path) {
  try {
    // Mode bits matter even under root, where access(W_OK) alone can succeed.
    if (!(statSync(path).mode & 0o222)) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch { return false; }
}

function isReadOnlyError(error) {
  return /readonly|read-only|permission|EACCES|EPERM|unable to open database/i.test(error.message);
}

const schema = `
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('context','file','symbol','fact','command','gotcha','decision')),
    title TEXT NOT NULL, normalized_title TEXT NOT NULL,
    body TEXT NOT NULL CHECK(length(body) <= 2000),
    paths TEXT NOT NULL, refs TEXT NOT NULL, terms TEXT NOT NULL,
    author TEXT, task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    hits INTEGER NOT NULL DEFAULT 0, saved_tokens INTEGER NOT NULL DEFAULT 0,
    UNIQUE(kind, normalized_title, paths)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    title, body, paths, terms, content='notes', content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid,title,body,paths,terms)
      VALUES(new.id,new.title,new.body,new.paths,new.terms);
  END;
  CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts,rowid,title,body,paths,terms)
      VALUES('delete',old.id,old.title,old.body,old.paths,old.terms);
  END;
  CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF title,body,paths,terms ON notes BEGIN
    INSERT INTO notes_fts(notes_fts,rowid,title,body,paths,terms)
      VALUES('delete',old.id,old.title,old.body,old.paths,old.terms);
    INSERT INTO notes_fts(rowid,title,body,paths,terms)
      VALUES(new.id,new.title,new.body,new.paths,new.terms);
  END;
`;

export function openKb(cwd, { readOnly = false, dbPath } = {}) {
  cwd = canonicalPath(cwd);
  const path = dbPath || kbPath(cwd);
  try { statSync(path); } catch (error) {
    if (readOnly && error.code === 'ENOENT') return null;
    if (error.code !== 'ENOENT') throw error;
  }
  if (!readOnly) {
    try { mkdirSync(dirname(path), { recursive: true }); }
    catch (error) { if (!isReadOnlyError(error)) throw error; readOnly = true; }
    if (!writable(dirname(path))) readOnly = true;
    try { statSync(path); if (!writable(path)) readOnly = true; } catch { /* new DB */ }
  }
  const Database = databaseClass();
  let db;
  function connect() {
    db = new Database(path, { readOnly });
    db.exec('PRAGMA busy_timeout=3000');
    if (!readOnly) { db.exec('PRAGMA journal_mode=DELETE'); db.exec(schema); }
  }
  try { connect(); }
  catch (error) {
    db?.close();
    if (readOnly || !isReadOnlyError(error)) throw error;
    readOnly = true;
    connect();
  }
  const root = repoRoot(cwd);
  const prepared = new Map();
  const statement = sql => {
    if (!prepared.has(sql)) prepared.set(sql, db.prepare(sql));
    return prepared.get(sql);
  };
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function requireWrite() {
    if (readOnly) throw new Error('Memory is read-only');
  }
  function detailed(row, searchRoot, cache) {
    return { ...note(row, staleRow(row, searchRoot, cache)), refs: JSON.parse(row.refs),
      createdAt: row.created_at, hits: row.hits, savedTokens: row.saved_tokens };
  }
  // Accounting for notes an agent actually received: fresh notes only, per-hit floor and cap.
  function account(items, searchRoot, cache) {
    const fresh = items.filter(item => !item.stale);
    if (readOnly || !fresh.length) return 0;
    try {
      transaction(() => {
        for (const { row } of fresh) {
          const bytes = JSON.parse(row.paths).reduce((sum, path) => sum + fileInfo(searchRoot, path, cache).size, 0);
          statement('UPDATE notes SET hits=hits+1,saved_tokens=saved_tokens+? WHERE id=?').run(Math.min(8000, Math.max(200, bytes / 4)), row.id);
        }
      });
      return fresh.length;
    } catch (error) {
      if (!isReadOnlyError(error)) throw error;
      readOnly = true;
      return 0;
    }
  }
  return {
    add({ kind, title, body, paths = [], author = null, taskId = null }) {
      requireWrite();
      if (!kinds.has(kind)) throw new Error('Unknown note kind');
      if (typeof title !== 'string' || !title.trim()) throw new Error('Provide a note title');
      if (typeof body !== 'string' || [...body].length > 2000) throw new Error('Note body must be at most 2000 characters');
      if ((author !== null && typeof author !== 'string') || (taskId !== null && typeof taskId !== 'string')) {
        throw new Error('Author and task must be strings');
      }
      paths = normalizePaths(paths, root);
      const cache = new Map();
      const refs = JSON.stringify(Object.fromEntries(paths.map(path => [path, fileInfo(root, path, cache).hash])));
      const normalized = title.toLowerCase().trim().replace(/\s+/gu, ' '), pathsJson = JSON.stringify(paths);
      const now = new Date().toISOString();
      return transaction(() => {
        const existing = statement('SELECT id FROM notes WHERE kind=? AND normalized_title=? AND paths=?')
          .get(kind, normalized, pathsJson);
        const identifiers = terms(`${title} ${body} ${paths.join(' ')}`);
        if (existing) {
          statement('UPDATE notes SET title=?,body=?,refs=?,terms=?,author=?,task_id=?,updated_at=? WHERE id=?')
            .run(title, body, refs, identifiers, author, taskId, now, existing.id);
          return { id: existing.id, updated: true };
        }
        const result = statement(`INSERT INTO notes
          (kind,title,normalized_title,body,paths,refs,terms,author,task_id,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(kind, title, normalized, body, pathsJson, refs, identifiers, author, taskId, now, now);
        return { id: Number(result.lastInsertRowid), updated: false };
      });
    },
    search(query, { limit = 5, kind, path: filterPath, cwd: searchCwd } = {}) {
      positiveInteger(limit, 'Limit');
      if (kind !== undefined && !kinds.has(kind)) throw new Error('Unknown note kind');
      const match = matchQuery(query);
      if (!match) return [];
      const searchRoot = searchCwd ? repoRoot(searchCwd) : root, params = [match];
      let sql = `SELECT n.*, bm25(notes_fts,6,2,1,3) AS rank
        FROM notes_fts JOIN notes n ON n.id=notes_fts.rowid WHERE notes_fts MATCH ?`;
      if (kind) { sql += ' AND n.kind=?'; params.push(kind); }
      if (filterPath !== undefined) {
        const [path] = normalizePaths([filterPath], searchRoot);
        sql += ` AND EXISTS (SELECT 1 FROM json_each(n.paths) WHERE value=? OR substr(value,1,length(?)+1)=?||'/')`;
        params.push(path, path, path);
      }
      const cache = new Map();
      const rows = statement(sql).all(...params).map(row => ({ row, stale: staleRow(row, searchRoot, cache) }));
      // Check every match before limiting: a highly ranked stale result must never hide a fresh one.
      rows.sort((a, b) => Number(a.stale) - Number(b.stale) || a.row.rank - b.row.rank || b.row.id - a.row.id);
      const selected = rows.slice(0, limit);
      account(selected, searchRoot, cache);
      return selected.map(({ row, stale }) => note(row, stale, -row.rank));
    },
    // Count notes handed to an agent outside search() (e.g. context given to Codex up front).
    recordUse(ids, { cwd: searchCwd } = {}) {
      const searchRoot = searchCwd ? repoRoot(searchCwd) : root, cache = new Map();
      const rows = [...new Set(ids.map(Number))].map(id => statement('SELECT * FROM notes WHERE id=?').get(id)).filter(Boolean)
        .map(row => ({ row, stale: staleRow(row, searchRoot, cache) }));
      return account(rows, searchRoot, cache);
    },
    context({ limit = 8, cwd: searchCwd } = {}) {
      positiveInteger(limit, 'Limit');
      const searchRoot = searchCwd ? repoRoot(searchCwd) : root, cache = new Map();
      const rows = statement(`SELECT * FROM notes WHERE kind IN ('context','decision','command','gotcha')`).all()
        .map(row => ({ row, stale: staleRow(row, searchRoot, cache) }));
      rows.sort((a, b) => Number(b.row.kind === 'context') - Number(a.row.kind === 'context') ||
        Number(a.stale) - Number(b.stale) || b.row.hits - a.row.hits ||
        b.row.updated_at.localeCompare(a.row.updated_at) || b.row.id - a.row.id);
      return rows.slice(0, limit).map(({ row, stale }) => note(row, stale));
    },
    stats() {
      const counts = statement('SELECT count(*) AS notes,coalesce(sum(hits),0) AS hits,coalesce(sum(saved_tokens),0) AS savedTokens FROM notes').get();
      const cache = new Map();
      return { ...counts, recent: statement('SELECT * FROM notes ORDER BY updated_at DESC,id DESC LIMIT 8').all()
        .map(row => ({ id: row.id, kind: row.kind, title: row.title, author: row.author, taskId: row.task_id,
          stale: staleRow(row, root, cache), updatedAt: row.updated_at })) };
    },
    get(id) {
      positiveInteger(Number(id), 'ID');
      const row = statement('SELECT * FROM notes WHERE id=?').get(Number(id));
      return row ? detailed(row, root, new Map()) : null;
    },
    list({ recent = 20 } = {}) {
      positiveInteger(recent, 'Limit');
      const cache = new Map();
      return statement('SELECT * FROM notes ORDER BY updated_at DESC,id DESC LIMIT ?').all(recent)
        .map(row => detailed(row, root, cache));
    },
    prune({ stale = false, cwd: searchCwd } = {}) {
      requireWrite();
      if (!stale) throw new Error('Pass --stale to delete stale notes');
      const searchRoot = searchCwd ? repoRoot(searchCwd) : root, cache = new Map();
      return transaction(() => {
        const ids = statement('SELECT id,refs FROM notes').all().filter(row => staleRow(row, searchRoot, cache));
        for (const { id } of ids) statement('DELETE FROM notes WHERE id=?').run(id);
        return ids.length;
      });
    },
    close() { db.close(); },
  };
}
