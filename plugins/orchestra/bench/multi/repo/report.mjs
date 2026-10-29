import { parseIds } from "./parse.mjs";
export function report(text) {
  return { count: parseIds(text).length };
}
