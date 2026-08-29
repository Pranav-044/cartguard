/**
 * POST /api/checkout
 *
 * Idempotent checkout endpoint.
 * Order of operations (non-negotiable):
 * 1. Validate request
 * 2. Check idempotency key — return existing order if found (NO Razorpay call)
 * 3. Run mandate engine — validate cart server-side (NEVER trust LLM amounts)
 * 4. Create Razorpay order (test mode)
 * 5. Persist order with idempotency key
 * 6. Log to audit trail
 * 7. Return order details for Checkout.js
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateOrder } from "@/lib/idempotency";
import { validateCart } from "@/lib/mandateEngine";
import type { CartItemWithProduct } from "@/lib/mandateEngine";
import { createRazorpayOrder } from "@/lib/razorpay";
import { logAction } from "@/lib/auditLog";
import mandateConfig from "../../../../mandate.config.json";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sessionId: string = body.sessionId;
    const idempotencyKey: string = body.idempotencyKey;
    const actor: string = body.actor ?? "human_chat";

    if (!sessionId || !idempotencyKey) {
      return NextResponse.json(
        { error: "sessionId and idempotencyKey are required" },
        { status: 400 }
      );
    }

    // ── Step 1: Idempotency check (before ANYTHING else) ──────────────────
    await logAction({
      sessionId,
      actor: actor,
      tool: "checkout_initiated",
      input: { sessionId, idempotencyKey, actor },
      reason: "Checkout requested — checking idempotency key first",
    });

    // ── Step 2: Load cart from DB ──────────────────────────────────────────
    const cartItems = await prisma.cartItem.findMany({
      where: { sessionId },
      include: { product: true },
    });

    if (cartItems.length === 0) {
      await logAction({
        sessionId,
        actor: "mandate_engine",
        tool: "checkout_blocked",
        input: { sessionId, idempotencyKey },
        output: { reason: "Empty cart" },
        decision: "blocked",
        reason: "Cannot checkout with an empty cart",
      });
      return NextResponse.json({ error: "Cart is empty" }, { status: 400 });
    }

    // ── Step 3: Mandate validation (server-side, deterministic) ───────────
    const isAgentMode = actor === "autonomous_buyer_agent";
    const validation = validateCart(
      cartItems as CartItemWithProduct[],
      mandateConfig,
      isAgentMode
    );

    await logAction({
      sessionId,
      actor: "mandate_engine",
      tool: "mandate_check",
      input: {
        cartTotal: validation.totalAmount,
        itemCount: validation.itemCount,
        isAgentMode,
      },
      output: { decision: validation.decision, violations: validation.violations },
      decision: validation.decision.allowed ? "allowed" : "blocked",
      reason: validation.decision.allowed
        ? `Mandate passed. Total: ₹${validation.totalAmount}`
        : `Mandate failed: ${validation.violations.join("; ")}`,
    });

    if (!validation.decision.allowed) {
      return NextResponse.json(
        {
          error: "Mandate check failed",
          violations: validation.violations,
          mandateDecision: validation.decision,
        },
        { status: 403 }
      );
    }

    if (
      !isAgentMode &&
      "requiresHumanConfirm" in validation.decision &&
      validation.decision.requiresHumanConfirm
    ) {
      return NextResponse.json(
        {
          requiresHumanConfirm: true,
          reason: validation.decision.reason,
          totalAmount: validation.totalAmount,
        },
        { status: 202 }
      );
    }

    // ── Step 4 & 5: Idempotent order creation ─────────────────────────────
    const { order, isExisting } = await getOrCreateOrder(
      idempotencyKey,
      sessionId,
      validation.totalAmount,
      "INR",
      async () => {
        // This function only called if no existing order
        const rzOrder = await createRazorpayOrder({
          amountINR: validation.totalAmount,
          currency: "INR",
          receipt: `cg_${sessionId.slice(0, 8)}_${Date.now()}`,
          notes: {
            sessionId,
            actor,
            cartItemCount: String(cartItems.length),
          },
        });
        return {
          razorpayOrderId: rzOrder.id,
          amount: validation.totalAmount,
          currency: "INR",
        };
      }
    );

    await logAction({
      sessionId,
      actor,
      tool: isExisting ? "checkout_idempotent_hit" : "checkout_order_created",
      input: { idempotencyKey, totalAmount: validation.totalAmount },
      output: {
        orderId: order.id,
        razorpayOrderId: order.razorpayOrderId,
        isExisting,
      },
      decision: "allowed",
      reason: isExisting
        ? `Idempotency hit — returning existing order ${order.id} (no duplicate Razorpay order created)`
        : `New Razorpay order created: ${order.razorpayOrderId}`,
    });

    return NextResponse.json({
      orderId: order.id,
      razorpayOrderId: order.razorpayOrderId,
      amount: Math.round(validation.totalAmount * 100), // paise for Checkout.js
      amountINR: validation.totalAmount,
      currency: "INR",
      keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
      isExisting,
    });
  } catch (error) {
    console.error("[/api/checkout]", error);
    return NextResponse.json(
      {
        error: "Checkout failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/checkout/verify — Verify payment signature after Checkout.js callback
// ---------------------------------------------------------------------------
