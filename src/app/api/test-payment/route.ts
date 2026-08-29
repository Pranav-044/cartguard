/**
 * POST /api/test-payment
 *
 * TEST-ONLY endpoint for simulating payment success/failure in the buyer agent demo.
 * This endpoint simulates what Checkout.js does in a browser — it verifies the
 * payment and updates the order status.
 *
 * SECURITY: Only active when ENABLE_TEST_PAYMENT=true in environment.
 * This endpoint MUST NOT exist in production.
 *
 * Used by: scripts/buyer-agent.ts to complete autonomous purchases.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/auditLog";
import crypto from "crypto";

export async function POST(request: NextRequest) {
  // Guard — only available when explicitly enabled
  if (process.env.ENABLE_TEST_PAYMENT !== "true") {
    return NextResponse.json(
      { error: "Test payment endpoint not enabled" },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const {
      orderId,
      razorpayOrderId,
      simulateFailure = false,
      actor = "autonomous_buyer_agent",
    } = body as {
      orderId: string;
      razorpayOrderId: string;
      simulateFailure?: boolean;
      actor?: string;
    };

    if (!orderId || !razorpayOrderId) {
      return NextResponse.json(
        { error: "orderId and razorpayOrderId required" },
        { status: 400 }
      );
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }

    if (simulateFailure) {
      // Simulate a declined card (like Razorpay test card 4000000000000002)
      await prisma.order.update({
        where: { id: orderId },
        data: { status: "failed" },
      });

      await logAction({
        sessionId: order.sessionId,
        actor,
        tool: "payment_failed",
        input: {
          orderId,
          razorpayOrderId,
          simulatedCard: "4000000000000002 (Decline)",
          testMode: true,
        },
        output: { status: "failed", errorCode: "BAD_REQUEST_ERROR" },
        decision: "blocked",
        reason:
          "TEST MODE: Simulated payment failure with decline test card. Agent will retry with success card.",
      });

      return NextResponse.json({
        success: false,
        status: "failed",
        errorCode: "BAD_REQUEST_ERROR",
        errorDescription:
          "Your card was declined. Please try a different payment method.",
        message:
          "Payment declined (test mode — using card 4000000000000002). Retry with success card.",
      });
    }

    // Simulate successful payment
    // Generate a fake test payment ID (real format: pay_XXXXX)
    const fakePaymentId = `pay_test_${crypto.randomBytes(8).toString("hex")}`;
    const fakeSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET ?? "test_secret")
      .update(`${razorpayOrderId}|${fakePaymentId}`)
      .digest("hex");

    await prisma.order.update({
      where: { id: orderId },
      data: {
        status: "paid",
        razorpayPaymentId: fakePaymentId,
      },
    });

    await prisma.session.update({
      where: { id: order.sessionId },
      data: { status: "completed" },
    });

    await logAction({
      sessionId: order.sessionId,
      actor,
      tool: "payment_success",
      input: {
        orderId,
        razorpayOrderId,
        simulatedCard: "4111111111111111 (Success)",
        testMode: true,
      },
      output: {
        paymentId: fakePaymentId,
        status: "paid",
        amount: order.amount,
      },
      decision: "allowed",
      reason: `TEST MODE: Simulated payment success. Order ${orderId} marked as paid. Actor: ${actor}`,
    });

    return NextResponse.json({
      success: true,
      status: "paid",
      paymentId: fakePaymentId,
      signature: fakeSignature,
      amount: order.amount,
      message: `TEST MODE: Payment simulated successfully. Order ${orderId} is now paid.`,
    });
  } catch (error) {
    console.error("[/api/test-payment]", error);
    return NextResponse.json(
      { error: "Test payment simulation failed", details: String(error) },
      { status: 500 }
    );
  }
}
