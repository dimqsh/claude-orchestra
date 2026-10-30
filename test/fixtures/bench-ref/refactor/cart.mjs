import { lineTotal } from "./pricing.mjs";
export function total(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}
export function receipt(items) {
  return items.map(item => `${item.name}: ${lineTotal(item)}`).join("\n");
}
