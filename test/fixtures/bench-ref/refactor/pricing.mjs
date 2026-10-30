export function lineTotal(item) {
  return Math.round(item.price * item.quantity * (1 - (item.discount ?? 0)));
}
