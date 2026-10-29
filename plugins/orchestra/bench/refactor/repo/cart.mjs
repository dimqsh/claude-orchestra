export function total(items) {
  return items.reduce((sum, item) => sum + Math.round(item.price * item.quantity * (1 - (item.discount ?? 0))), 0);
}
export function receipt(items) {
  return items.map(item => `${item.name}: ${Math.round(item.price * item.quantity * (1 - (item.discount ?? 0)))}`).join("\n");
}
