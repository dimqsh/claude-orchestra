export function subtotal(items, discount = 0) {
  return items.reduce((sum, item) => sum + item.price * (item.quantity ?? 1), 0) * (1 - discount);
}
