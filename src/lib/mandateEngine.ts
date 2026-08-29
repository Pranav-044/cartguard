/**
 * Mandate Engine — deterministic, pure functions, no LLM involvement.
 *
 * SECURITY PRINCIPLE: The LLM never authorizes a money action.
 * Every spend decision is recomputed here from structured data.
 * The engine is called server-side, after injection sanitization,
 * and before any Razorpay API call is made.
 */

import type {
  MandateConfig,
  MandateDecision,
  CartValidation,
  CartItem,
  Product,
} from "@/types";

// ---------------------------------------------------------------------------
// Individual check functions (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Check if a single item's price exceeds the per-item cap.
 * Never trusts the price from LLM output — always reads from the Product DB record.
 */
export function checkPerItemCap(
  price: number,
  capINR: number
): { passed: boolean; reason?: string } {
  if (price > capINR) {
    return {
      passed: false,
      reason: `Item price ₹${price} exceeds per-item cap of ₹${capINR}`,
    };
  }
  return { passed: true };
}

/**
 * Check if the total cart value exceeds the budget cap.
 */
export function checkBudgetCap(
  totalINR: number,
  capINR: number
): { passed: boolean; reason?: string } {
  if (totalINR > capINR) {
    return {
      passed: false,
      reason: `Cart total ₹${totalINR} exceeds budget cap of ₹${capINR}`,
    };
  }
  return { passed: true };
}

/**
 * Check if all items belong to the allowed category list.
 */
export function checkCategoryAllowlist(
  items: Array<{ category: string; name: string }>,
  allowlist: string[]
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  for (const item of items) {
    if (!allowlist.includes(item.category)) {
      violations.push(
        `"${item.name}" (category: ${item.category}) is not in the allowed category list`
      );
    }
  }
  return { passed: violations.length === 0, violations };
}

/**
 * Check if the total requires a human confirmation step.
 * For agent-to-agent mode, this threshold is bypassed (see mandate.config.json).
 */
export function checkHumanConfirmThreshold(
  totalINR: number,
  thresholdINR: number
): { requiresConfirm: boolean; reason?: string } {
  if (totalINR >= thresholdINR) {
    return {
      requiresConfirm: true,
      reason: `Cart total ₹${totalINR} meets or exceeds human-confirm threshold of ₹${thresholdINR}. Human approval required before checkout.`,
    };
  }
  return { requiresConfirm: false };
}

/**
 * Check cart item count.
 */
export function checkMaxItems(
  itemCount: number,
  maxItems: number
): { passed: boolean; reason?: string } {
  if (itemCount > maxItems) {
    return {
      passed: false,
      reason: `Cart has ${itemCount} items, exceeding maximum of ${maxItems}`,
    };
  }
  return { passed: true };
}

// ---------------------------------------------------------------------------
// Composite validation (called at checkout time)
// ---------------------------------------------------------------------------

export interface CartItemWithProduct extends CartItem {
  product: Product;
}

/**
 * Full cart validation — the single function called before any checkout.
 * Recomputes prices from DB records, never from LLM-provided values.
 */
export function validateCart(
  items: CartItemWithProduct[],
  config: MandateConfig,
  isAgentMode = false
): CartValidation {
  const violations: string[] = [];

  // Recompute total from DB prices (NEVER trust LLM-provided amounts)
  const totalAmount = items.reduce(
    (sum, item) => sum + item.product.price * item.quantity,
    0
  );
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  // Effective config — buyer agent uses overrides
  const effectiveBudgetCap = isAgentMode
    ? (config.buyerAgentOverrides?.budgetCapINR ?? config.budgetCapINR)
    : config.budgetCapINR;
  const effectiveConfirmThreshold = isAgentMode
    ? (config.buyerAgentOverrides?.humanConfirmThresholdINR ??
        config.humanConfirmThresholdINR)
    : config.humanConfirmThresholdINR;

  // 1. Per-item cap check
  for (const item of items) {
    const itemCheck = checkPerItemCap(item.product.price, config.perItemCapINR);
    if (!itemCheck.passed && itemCheck.reason) {
      violations.push(itemCheck.reason);
    }
  }

  // 2. Category allowlist check
  const categoryCheck = checkCategoryAllowlist(
    items.map((i) => ({ category: i.product.category, name: i.product.name })),
    config.categoryAllowlist
  );
  violations.push(...categoryCheck.violations);

  // 3. Max item count check
  const maxItemsCheck = checkMaxItems(itemCount, config.maxCartItems);
  if (!maxItemsCheck.passed && maxItemsCheck.reason) {
    violations.push(maxItemsCheck.reason);
  }

  // 4. Budget cap check
  const budgetCheck = checkBudgetCap(totalAmount, effectiveBudgetCap);
  if (!budgetCheck.passed && budgetCheck.reason) {
    violations.push(budgetCheck.reason);
  }

  // Determine final decision
  let decision: MandateDecision;

  if (violations.length > 0) {
    decision = {
      allowed: false,
      requiresHumanConfirm: false,
      reason: violations.join("; "),
    };
  } else {
    // 5. Human confirm threshold (only for human-in-the-loop mode)
    const confirmCheck = checkHumanConfirmThreshold(
      totalAmount,
      effectiveConfirmThreshold
    );
    if (confirmCheck.requiresConfirm && confirmCheck.reason) {
      decision = {
        allowed: true,
        requiresHumanConfirm: true,
        reason: confirmCheck.reason,
      };
    } else {
      decision = { allowed: true, requiresHumanConfirm: false };
    }
  }

  return {
    totalAmount,
    itemCount,
    decision,
    violations,
  };
}

/**
 * Quick check for a proposed upsell item — before adding to cart.
 */
export function validateUpsellItem(
  product: Product,
  currentTotal: number,
  config: MandateConfig,
  isAgentMode = false
): { allowed: boolean; reason?: string } {
  const effectiveBudgetCap = isAgentMode
    ? (config.buyerAgentOverrides?.budgetCapINR ?? config.budgetCapINR)
    : config.budgetCapINR;

  const newTotal = currentTotal + product.price;

  if (!config.categoryAllowlist.includes(product.category)) {
    return {
      allowed: false,
      reason: `Category "${product.category}" not in allowlist`,
    };
  }

  if (product.price > config.perItemCapINR) {
    return {
      allowed: false,
      reason: `Item price ₹${product.price} exceeds per-item cap ₹${config.perItemCapINR}`,
    };
  }

  if (newTotal > effectiveBudgetCap) {
    return {
      allowed: false,
      reason: `Adding this item would bring total to ₹${newTotal}, exceeding budget cap ₹${effectiveBudgetCap}`,
    };
  }

  return { allowed: true };
}
