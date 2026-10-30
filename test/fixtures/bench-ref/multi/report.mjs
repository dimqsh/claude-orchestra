import { parseIds } from "./parse.mjs";
export function report(text) {
  const ids = parseIds(text);
  return { count: ids.length, ids };
}
