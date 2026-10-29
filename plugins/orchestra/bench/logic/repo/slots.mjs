export function available(slots, start, end) {
  return slots.filter(slot => slot.start >= start && slot.end <= end);
}
