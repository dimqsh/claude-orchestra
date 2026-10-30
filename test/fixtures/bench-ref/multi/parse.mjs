export function parseIds(text) {
  return [...new Set(text.split(",").map(s => s.trim()).filter(s => /^\d+$/.test(s))
    .map(Number).filter(n => Number.isSafeInteger(n) && n > 0))];
}
