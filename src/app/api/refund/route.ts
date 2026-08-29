/**
 * POST /api/refund
 *
 * Initiate a refund for a paid order.
 * Closes the full order lifecycle: created → paid → refunded.
 *
 * TEST MODE: If the payment ID starts with "pay_test_", we simulate the refund
 * rather than calling Razorpay (since the payment was never real).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createRefund } from "@/lib/razorpay";
import { logAction } from "@/lib/auditLog";
import crypto from "crypto";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { orderId, actor = "human_chat" } = body as {
      orderId: string;
      actor?: string;
    };

    if (!orderId) {
      return NextResponse.json({ error: "orderId required" }, { status: 400 });
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (order.status !== "paid") {
      await logAction({
        sessionId: order.sessionId,
        actor,
        tool: "refund_blocked",
        input: { orderId, currentStatus: order.status },
        decision: "blocked",
        reason: `Cannot refund order in status "${order.status}" — must be "paid"`,
      });
      return NextResponse.json(
        { error: `Cannot refund order with status "${order.status}"` },
        { status: 400 }
      );
    }

    if (!order.razorpayPaymentId) {
      return NextResponse.json(
        { error: "No payment ID associated with this order" },
        { status: 400 }
      );
    }

    await logAction({
      sessionId: order.sessionId,
      actor,
      tool: "refund_initiated",
      input: { orderId, paymentId: order.razorpayPaymentId, amount: order.amount },
      reason: "Refund requested",
    });

    const isTestPayment =
      order.razorpayPaymentId.startsWith("pay_test_") ||
      process.env.ENABLE_TEST_PAYMENT === "true";

    let refundId: string;
    let refundStatus: string;
    let refundAmount: number;

    if (isTestPayment) {
      // Simulate refund for test-mode payments — Razorpay API would reject fake IDs
      refundId = `rfnd_test_${crypto.randomBytes(8).toString("hex")}`;
      refundStatus = "processed";
      refundAmount = order.amount;

      await logAction({
        sessionId: order.sessionId,
        actor,
        tool: "refund_simulated",
        input: { orderId, paymentId: order.razorpayPaymentId },
        output: { refundId, note: "Simulated — test payment ID cannot be refunded via Razorpay API" },
        decision: "allowed",
        reason: `TEST MODE: Simulated refund ${refundId} for test payment ${order.razorpayPaymentId}`,
      });
    } else {
      // Real Razorpay refund
      const refund = await createRefund(
        order.razorpayPaymentId,
        Math.round(order.amount * 100) // paise
      );
      refundId = refund.id;
      refundStatus = refund.status;
      refundAmount = refund.amount;
    }

    // Update order status
    await prisma.order.update({
      where: { id: orderId },
      data: { status: "refunded", refundId },
    });

    await logAction({
      sessionId: order.sessionId,
      actor,
      tool: "refund_success",
      input: { orderId, paymentId: order.razorpayPaymentId },
      output: { refundId, status: refundStatus, amount: refundAmount },
      decision: "allowed",
      reason: `Refund ${refundId} for ₹${order.amount}. Full lifecycle: created → paid → refunded ✓`,
    });

    return NextResponse.json({
      success: true,
      refundId,
      paymentId: order.razorpayPaymentId,
      amount: order.amount,
      status: refundStatus,
      message: `Refund of ₹${order.amount} initiated successfully. Lifecycle: created → paid → refunded ✓`,
    });
  } catch (error) {
    console.error("[/api/refund]", error);
    return NextResponse.json(
      {
        error: "Refund failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
