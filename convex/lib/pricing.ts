export function getEffectivePrice(
  basePrice: number,
  dynamicPrice?: number,
  isSurgeActive?: boolean,
): number {
  return isSurgeActive && dynamicPrice !== undefined ? dynamicPrice : basePrice;
}

export function applyDiscount(price: number, discountPercent: number): number {
  const discount = Math.min(Math.max(discountPercent, 0), 100);
  return Math.round(price * (1 - discount / 100) * 100) / 100;
}
