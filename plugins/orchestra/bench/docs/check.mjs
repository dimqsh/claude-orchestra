import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.argv[2];
const text = await readFile(join(root, 'README.md'), 'utf8');
for (const pattern of [/slug\(text\)/, /\.\/slug\.mjs/, /lowercase/i, /trim/i, /hyphen/i, /empty/i, /TypeError/, /non.string/i, /Hello, World!/, /hello-world/, /!!!/]) assert.match(text, pattern);
const blocks = [...text.matchAll(/```(?:js|javascript|mjs)\n([\s\S]*?)```/g)];
assert.ok(blocks.some(([, code]) => /import\s+[^;\n]*['"]\.\/slug\.mjs['"]/.test(code) && /\bslug\s*\(/.test(code)),
  'include a JavaScript example that imports ./slug.mjs and calls slug');
const { mkdtemp, cp, writeFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { spawnSync } = await import('node:child_process');
const temp = await mkdtemp(join(tmpdir(), 'bench-docs-check-'));
try {
  await cp(root, temp, { recursive: true });
  for (const [i, block] of blocks.entries()) {
    const path = join(temp, `example-${i}.mjs`);
    await writeFile(path, block[1]);
    const result = spawnSync(process.execPath, [path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  }
} finally { await rm(temp, { recursive: true, force: true }); }
const { slug } = await import(pathToFileURL(join(root, 'slug.mjs')));
assert.equal(slug(' Hello, World! '), 'hello-world');
assert.equal(slug('!!!'), '');
assert.throws(() => slug(123), TypeError);
