// Node's explicit directory entrypoint (node --test test/).
import { readdir } from 'node:fs/promises';
for (const file of (await readdir(new URL('.', import.meta.url))).sort()) {
  if (file.endsWith('.test.mjs')) await import(new URL(file, import.meta.url));
}
