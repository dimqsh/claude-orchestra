export function available(slots, start, end) {
  if (end <= start) return [];
  return slots.filter(slot => slot.start < end && slot.end > start)
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
