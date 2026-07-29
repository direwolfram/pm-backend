export function computeSellable(available: number, reserved: number): number {
  return Math.max(available - reserved, 0);
}

export function isLowStock(sellable: number, threshold: number): boolean {
  return sellable <= threshold;
}

export function pickPriorityScore(expiryDate: number): number {
  return -expiryDate;
}

const MANILA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

export function shelfLifeDaysRemaining(expiryDate: number, nowMs: number): number {
  const expiryDay = Math.floor((expiryDate + MANILA_UTC_OFFSET_MS) / 86_400_000);
  const today = Math.floor((nowMs + MANILA_UTC_OFFSET_MS) / 86_400_000);
  return expiryDay - today;
}

export function nextManilaMidnightAfter(t: number) {
  const day = 86_400_000;
  return (
    (Math.floor((t + MANILA_UTC_OFFSET_MS) / day) + 1) * day -
    MANILA_UTC_OFFSET_MS
  );
}

export function nextShelfLifeRefreshAt(_expiryDate: number, evaluatedAt: number) {
  return nextManilaMidnightAfter(evaluatedAt);
}
