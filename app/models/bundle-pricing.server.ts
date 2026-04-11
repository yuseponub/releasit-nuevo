/**
 * Bundle pricing logic for COD orders.
 * Prices are in COP (whole numbers, not cents).
 */

// Default bundle pricing
const DEFAULT_PRICING: Record<number, number> = {
  1: 79900,
  2: 129900,
  3: 169900,
};

export function calcBundlePrice(
  totalQty: number,
  customPricing?: Record<number, number>
): number {
  if (totalQty <= 0) return 0;

  const pricing = customPricing || DEFAULT_PRICING;

  if (pricing[totalQty]) {
    return pricing[totalQty];
  }

  // For quantities > max defined, use the best per-unit price
  const maxQty = Math.max(...Object.keys(pricing).map(Number));
  const bestPerUnit = Math.round(pricing[maxQty] / maxQty);
  return totalQty * bestPerUnit;
}

export function calcPerUnitPrice(
  totalQty: number,
  customPricing?: Record<number, number>
): number {
  const total = calcBundlePrice(totalQty, customPricing);
  return Math.round(total / totalQty);
}

export function calcSavings(
  totalQty: number,
  customPricing?: Record<number, number>
): number {
  const pricing = customPricing || DEFAULT_PRICING;
  const fullPrice = totalQty * (pricing[1] || 79900);
  const bundlePrice = calcBundlePrice(totalQty, customPricing);
  return Math.max(0, fullPrice - bundlePrice);
}

/**
 * Distribute the bundle price proportionally across line items.
 * Returns an array of per-unit prices for each item.
 */
export function distributePrice(
  items: Array<{ quantity: number }>,
  totalQty: number,
  customPricing?: Record<number, number>
): number[] {
  const bundleTotal = calcBundlePrice(totalQty, customPricing);
  const perUnit = Math.floor(bundleTotal / totalQty);
  const remainder = bundleTotal - perUnit * totalQty;

  return items.map((item, idx) => {
    // Give the remainder to the first item
    const extra = idx === 0 ? remainder : 0;
    return perUnit * item.quantity + extra;
  });
}
