#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openKb } from '../lib/kb.mjs';

const oneLine = value => String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/gu, ' ').trim();
function age(updatedAt) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(updatedAt)) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h`;
  return `${Math.floor(minutes / 1440)} d`;
}

export function formatNotes(notes) {
  if (!notes.length) return 'Nothing found';
  return notes.map(note => {
    let body = [...oneLine(note.body)];
    if (body.length > 300) body = [...body.slice(0, 299), '…'];
    return `[${note.id}] ${note.kind} · ${oneLine(note.title)}${note.paths.length ? `  (${note.paths.map(oneLine).join(', ')})` : ''}` +
      `${note.author ? ` · ${oneLine(note.author)}` : ''} · ${age(note.updatedAt)} ${note.stale ? 'stale' : '✓'}\n     ${body.join('')}`;
  }).join('\n');
}

export function runKb(argv = process.argv.slice(2)) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      cwd: { type: 'string' }, limit: { type: 'string' }, kind: { type: 'string' },
      path: { type: 'string' }, json: { type: 'boolean' }, title: { type: 'string' },
      paths: { type: 'string' }, task: { type: 'string' }, author: { type: 'string' },
      body: { type: 'string' }, recent: { type: 'string' }, stale: { type: 'boolean' },
    } }));
  } catch { throw new Error('Unknown option or missing option value'); }
  const [command, arg] = positionals;
  const options = {
    search: ['limit', 'kind', 'path', 'json'], add: ['kind', 'title', 'paths', 'task', 'author', 'body'],
    context: ['json'], get: [], list: ['recent'], stats: ['json'], prune: ['stale'],
  };
  if (!Object.hasOwn(options, command || '')) throw new Error('Provide a command: search, add, context, get, list, stats, prune');
  if (Object.keys(values).some(key => key !== 'cwd' && !options[command].includes(key))) throw new Error('This command does not support that option');
  const needsArg = command === 'search' || command === 'get';
  if (positionals.length !== (needsArg ? 2 : 1)) throw new Error(needsArg ? 'Provide a query or an ID' : 'Too many arguments for this command');
  if (command === 'prune' && !values.stale) throw new Error('Provide --stale');
  if (command === 'add' && (!values.kind || !values.title)) throw new Error('Provide --kind and --title');
  // Pure reads never create a database; search also updates hit counters.
  const kb = openKb(values.cwd || process.cwd(), { readOnly: command !== 'search' && command !== 'add' && command !== 'prune' });
  try {
    if (command === 'add') {
      const result = kb.add({ kind: values.kind, title: values.title,
        body: values.body ?? readFileSync(0, 'utf8'), paths: values.paths ? values.paths.split(',').map(path => path.trim()) : [],
        author: values.author ?? null, taskId: values.task ?? null });
      return `[${result.id}] ${result.updated ? 'updated' : 'added'}`;
    }
    if (command === 'search') {
      const hits = kb.search(arg, { limit: values.limit === undefined ? 5 : Number(values.limit), kind: values.kind, path: values.path });
      return values.json ? JSON.stringify(hits) : formatNotes(hits);
    }
    if (command === 'context') {
      const notes = kb?.context() || [];
      return values.json ? JSON.stringify(notes) : formatNotes(notes);
    }
    if (command === 'get') {
      const note = kb?.get(arg);
      if (!note) throw new Error('Note not found');
      return formatNotes([note]);
    }
    if (command === 'list') return formatNotes(kb?.list({ recent: values.recent === undefined ? 20 : Number(values.recent) }) || []);
    if (command === 'stats') {
      const stats = kb?.stats() || { notes: 0, hits: 0, savedTokens: 0, recent: [] };
      return values.json ? JSON.stringify(stats) : `Notes: ${stats.notes} · hits: ${stats.hits} · ≈${stats.savedTokens} tokens saved`;
    }
    return `Notes deleted: ${kb.prune({ stale: true })}`;
  } finally { kb?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(runKb()); }
  catch (error) {
    const message = oneLine(error.message);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
