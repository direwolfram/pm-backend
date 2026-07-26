export function computeSellable(available: number, reserved: number): number {
  return Math.max(available - reserved, 0);
}

export function isLowStock(sellable: number, threshold: number): boolean {
  return sellable <= threshold;
}

export function pickPriorityScore(expiryDate: number): number {
  return -expiryDate;
}

export function shelfLifeDaysRemaining(expiryDate: number, nowMs: number): number {
  return Math.floor((expiryDate - nowMs) / 86_400_000);
}
