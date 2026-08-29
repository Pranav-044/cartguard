/**
 * Idempotency Layer
 *
 * Ensures that retried checkout requests (network blips, double-clicks,
 * agent retry logic) never create duplicate Razorpay orders.
 *
 * Implementation:
 * - idempotencyKey is stored on the Order row with a UNIQUE constraint
 * - On conflict, we return the existing order instead of creating a new one
 * - Key format: `session:{sessionId}:attempt:{attemptNumber}`
 *
 * This is the first thing checked in /api/checkout, before Razorpay is called.
 */

import { prisma } from "@/lib/prisma";
import type { Order } from "@/types";

/**
 * Generate a deterministic idempotency key for a checkout attempt.
 */
export function generateIdempotencyKey(
  sessionId: string,
  attemptNumber: number = 1
): string {
  return `session:${sessionId}:attempt:${attemptNumber}`;
}

/**
 * Look up an existing order by idempotency key.
 * Returns null if no order exists yet.
 */
export async function findOrderByIdempotencyKey(
  idempotencyKey: string
): Promise<Order | null> {
  const order = await prisma.order.findUnique({
    where: { idempotencyKey },
  });
  return order as Order | null;
}

/**
 * Get or create an order atomically.
 *
 * If an order with this idempotency key already exists, return it
 * (with isExisting: true) without calling Razorpay again.
 *
 * If it doesn't exist, call the provided createFn and persist the result.
 */
export async function getOrCreateOrder(
  idempotencyKey: string,
  sessionId: string,
  amount: number,
  currency: string,
  createFn: () => Promise<{
    razorpayOrderId: string;
    amount: number;
    currency: string;
  }>
): Promise<{ order: Order; isExisting: boolean }> {
  // Check for existing order first (before any Razorpay call)
  const existing = await findOrderByIdempotencyKey(idempotencyKey);
  if (existing) {
    return { order: existing, isExisting: true };
  }

  // No existing order — create Razorpay order
  const razorpayResult = await createFn();

  // Persist to DB with unique idempotency key
  try {
    const order = await prisma.order.create({
      data: {
        sessionId,
        idempotencyKey,
        razorpayOrderId: razorpayResult.razorpayOrderId,
        amount: razorpayResult.amount,
        currency: razorpayResult.currency,
        status: "created",
      },
    });
    return { order: order as Order, isExisting: false };
  } catch (error: unknown) {
    // Handle race condition: unique constraint violation means another request
    // created the order concurrently — fetch and return that one
    if (
      error instanceof Error &&
      error.message.includes("Unique constraint failed")
    ) {
      const concurrent = await findOrderByIdempotencyKey(idempotencyKey);
      if (concurrent) {
        return { order: concurrent, isExisting: true };
      }
    }
    throw error;
  }
}
