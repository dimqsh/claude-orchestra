import { mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJSON, catalogPath, orchestraConfig } from './paths.mjs';

export const TASK_TYPES = ['bug', 'logic', 'refactor', 'tests', 'docs', 'search'];

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

/**
 * One executor and model (docs/superpowers/specs/2026-10-29-executor-routing-design.md, section 1).
 * @typedef {object} Entry
 * @property {string} id                 "<provider>:<model>", see entryId()
 * @property {string} provider
 * @property {string} model
 * @property {string} runner             script that runs it, e.g. "codex-task.mjs"
 * @property {string[]} efforts
 * @property {{ ok: boolean, checkedAt: string, error?: string }} available
 * @property {string} access             e.g. "subscription: ChatGPT Pro"
 * @property {object} public             public benchmark figures and prices
 * @property {object} own                our own benchmark results, by task type
 * @property {string} notes
 *
 * @typedef {object} Catalog
 * @property {1} version
 * @property {string|null} updatedAt
 * @property {string|null} discoveredAt
 * @property {string|null} benchmarksAt
 * @property {Record<string, Entry>} models
 */

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const emptyCatalog = () => ({ version: 1, updatedAt: null, discoveredAt: null, benchmarksAt: null, models: {} });

export const entryId = (provider, model) => `${provider}:${model}`;

export function allowFable() {
  return orchestraConfig().allowFable === true;
}

/** @returns {Promise<Catalog>} An empty catalog when the file does not exist yet; any other failure throws. */
export async function readCatalog() {
  let text;
  try { text = await readFile(catalogPath(), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return emptyCatalog();
    throw error;
  }
  const value = JSON.parse(text);
  return { ...emptyCatalog(), ...(isObject(value) ? value : {}), models: isObject(value?.models) ? value.models : {} };
}

// Exclusive-create lock file next to the catalog: whoever creates it owns the read-modify-write.
async function withLock(work) {
  const lock = `${catalogPath()}.lock`;
  await mkdir(dirname(lock), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { await (await open(lock, 'wx')).close(); break; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // A crashed owner leaves the file behind; take over once it is older than any real update.
    const age = await stat(lock).then(info => Date.now() - info.mtimeMs, () => 0);
    if (age > LOCK_STALE_MS) { await rm(lock, { force: true }); continue; }
    if (Date.now() >= deadline) throw new Error(`Model catalog is locked by another process (${lock})`);
    await sleep(5 + Math.random() * 10);
  }
  try { return await work(); } finally { await rm(lock, { force: true }); }
}

/**
 * Reads the catalog, lets `mutator` change it in place, and writes it back atomically.
 * Updates from concurrent callers and processes are serialized, so none is lost.
 * @param {(catalog: Catalog) => void | Promise<void>} mutator
 * @returns {Promise<Catalog>}
 */
export function updateCatalog(mutator) {
  return withLock(async () => {
    const catalog = await readCatalog();
    await mutator(catalog);
    catalog.updatedAt = new Date().toISOString();
    await atomicJSON(catalogPath(), catalog);
    return catalog;
  });
}
