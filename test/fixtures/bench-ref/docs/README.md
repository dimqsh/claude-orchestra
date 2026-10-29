# Slug

`slug(text)` trims whitespace, converts to lowercase, replaces each run of non-ASCII-alphanumeric characters with one hyphen, and removes edge hyphens. An empty or punctuation-only input returns an empty string. Non-string input throws TypeError.

```js
import assert from "node:assert/strict";
import { slug } from "./slug.mjs";
assert.equal(slug(" Hello, World! "), "hello-world");
assert.equal(slug("!!!"), "");
```
