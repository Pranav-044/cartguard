/**
 * POST /api/checkout/verify
 * Verify a Razorpay payment signature after Checkout.js callback.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyPaymentSignature } from "@/lib/razorpay";
import { logAction } from "@/lib/auditLog";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      orderId,
      actor = "human_chat",
    } = body as {
      razorpayOrderId: string;
      razorpayPaymentId: string;
      razorpaySignature: string;
      orderId: string;
      actor?: string;
    };

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return NextResponse.json(
        { error: "razorpayOrderId, razorpayPaymentId, and razorpaySignature required" },
        { status: 400 }
      );
    }

    // Verify signature server-side
    const isValid = verifyPaymentSignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    if (!isValid) {
      await logAction({
        actor: "mandate_engine",
        tool: "signature_verification_failed",
        input: { razorpayOrderId, razorpayPaymentId },
        decision: "blocked",
        reason: "Payment signature verification failed — possible tampering",
      });
      return NextResponse.json(
        { error: "Payment signature verification failed" },
        { status: 400 }
      );
    }

    // Update order status
    const order = await prisma.order.findFirst({
      where: { razorpayOrderId },
    });

    if (order) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: "paid", razorpayPaymentId },
      });

      await prisma.session.update({
        where: { id: order.sessionId },
        data: { status: "completed" },
      });

      await logAction({
        sessionId: order.sessionId,
        actor,
        tool: "payment_success",
        input: { razorpayOrderId, razorpayPaymentId },
        output: { orderId: order.id, status: "paid" },
        decision: "allowed",
        reason: `Payment ${razorpayPaymentId} verified and captured. Order ${order.id} marked paid.`,
      });
    }

    return NextResponse.json({ success: true, verified: true, orderId });
  } catch (error) {
    console.error("[/api/checkout/verify]", error);
    return NextResponse.json(
      { error: "Verification failed", details: String(error) },
      { status: 500 }
    );
  }
}
