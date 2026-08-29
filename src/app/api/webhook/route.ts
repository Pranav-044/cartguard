/**
 * POST /api/webhook — Razorpay Webhook Handler
 *
 * Source of truth for payment status (not the client callback).
 * Webhooks can arrive before or after the client callback, or
 * the client callback can be missed entirely.
 *
 * Deduplication: by razorpay_payment_id (UNIQUE constraint).
 * If the same payment event arrives twice, we log the duplicate
 * and return 200 (Razorpay expects 200 for all webhooks).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyWebhookSignature } from "@/lib/razorpay";
import { logAction } from "@/lib/auditLog";

interface RazorpayWebhookPayment {
  id: string;
  order_id: string;
  status: string;
  amount: number;
  currency: string;
  error_code?: string;
  error_description?: string;
}

interface RazorpayWebhookPayload {
  event: string;
  payload: {
    payment?: {
      entity: RazorpayWebhookPayment;
    };
    refund?: {
      entity: {
        id: string;
        payment_id: string;
        amount: number;
        status: string;
      };
    };
  };
}

export async function POST(request: NextRequest) {
  let rawBody: string;
  let webhookPayload: RazorpayWebhookPayload;

  try {
    rawBody = await request.text();
    webhookPayload = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // ── Signature verification (always, before any state change) ───────────
  const signature = request.headers.get("x-razorpay-signature");

  if (signature && process.env.RAZORPAY_WEBHOOK_SECRET) {
    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
      await logAction({
        actor: "webhook",
        tool: "webhook_signature_invalid",
        input: { event: webhookPayload.event },
        decision: "blocked",
        reason: "Webhook signature verification failed — request rejected",
      });
      // Still return 200 to avoid Razorpay retrying with a bad signature
      return NextResponse.json({ status: "signature_invalid" });
    }
  }

  const { event, payload } = webhookPayload;

  await logAction({
    actor: "webhook",
    tool: "webhook_received",
    input: { event, paymentId: payload.payment?.entity.id },
    reason: `Webhook event received: ${event}`,
  });

  // ── Event handlers ─────────────────────────────────────────────────────
  try {
    switch (event) {
      case "payment.captured": {
        const payment = payload.payment?.entity;
        if (!payment) break;

        // Deduplicate by razorpay_payment_id
        const existingOrder = await prisma.order.findFirst({
          where: { razorpayPaymentId: payment.id },
        });

        if (existingOrder) {
          await logAction({
            actor: "webhook",
            tool: "webhook_duplicate",
            input: { paymentId: payment.id, event },
            output: { existingOrderId: existingOrder.id },
            decision: "allowed",
            reason: `Duplicate webhook for payment ${payment.id} — already processed, ignoring`,
          });
          return NextResponse.json({ status: "duplicate_ignored" });
        }

        // Find order by Razorpay order ID
        const order = await prisma.order.findFirst({
          where: { razorpayOrderId: payment.order_id },
        });

        if (!order) {
          await logAction({
            actor: "webhook",
            tool: "webhook_order_not_found",
            input: { razorpayOrderId: payment.order_id, paymentId: payment.id },
            decision: "blocked",
            reason: `No local order found for Razorpay order ${payment.order_id}`,
          });
          return NextResponse.json({ status: "order_not_found" });
        }

        // Update order status
        await prisma.order.update({
          where: { id: order.id },
          data: {
            status: "paid",
            razorpayPaymentId: payment.id,
          },
        });

        // Mark session as completed
        await prisma.session.update({
          where: { id: order.sessionId },
          data: { status: "completed" },
        });

        await logAction({
          sessionId: order.sessionId,
          actor: "webhook",
          tool: "payment_success",
          input: { paymentId: payment.id, amount: payment.amount },
          output: { orderId: order.id, status: "paid" },
          decision: "allowed",
          reason: `Payment ${payment.id} captured successfully. Order ${order.id} marked as paid.`,
        });

        break;
      }

      case "payment.failed": {
        const payment = payload.payment?.entity;
        if (!payment) break;

        const order = await prisma.order.findFirst({
          where: { razorpayOrderId: payment.order_id },
        });

        if (order) {
          await prisma.order.update({
            where: { id: order.id },
            data: { status: "failed" },
          });

          await logAction({
            sessionId: order.sessionId,
            actor: "webhook",
            tool: "payment_failed",
            input: {
              paymentId: payment.id,
              errorCode: payment.error_code,
              errorDescription: payment.error_description,
            },
            output: { orderId: order.id, status: "failed" },
            decision: "blocked",
            reason: `Payment failed: ${payment.error_description ?? payment.error_code ?? "Unknown error"}`,
          });
        }
        break;
      }

      case "refund.created":
      case "refund.processed": {
        const refund = payload.refund?.entity;
        if (!refund) break;

        const order = await prisma.order.findFirst({
          where: { razorpayPaymentId: refund.payment_id },
        });

        if (order) {
          await prisma.order.update({
            where: { id: order.id },
            data: { status: "refunded", refundId: refund.id },
          });

          await logAction({
            sessionId: order.sessionId,
            actor: "webhook",
            tool: "refund_processed",
            input: { refundId: refund.id, paymentId: refund.payment_id },
            output: { orderId: order.id, status: "refunded" },
            decision: "allowed",
            reason: `Refund ${refund.id} processed for payment ${refund.payment_id}`,
          });
        }
        break;
      }

      default:
        await logAction({
          actor: "webhook",
          tool: "webhook_unhandled",
          input: { event },
          reason: `Unhandled webhook event type: ${event}`,
        });
    }
  } catch (error) {
    await logAction({
      actor: "webhook",
      tool: "webhook_error",
      input: { event },
      output: { error: String(error) },
      reason: `Error processing webhook: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  // Always return 200 to Razorpay (they retry on non-200)
  return NextResponse.json({ status: "ok" });
}
