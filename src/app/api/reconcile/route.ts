/**
 * POST /api/reconcile
 *
 * Reconciliation job — fetches order status from Razorpay for orders
 * that have been in "attempted" state too long, and corrects local state.
 *
 * In production: run every N minutes as a cron job.
 * For demo: trigger via "Reconcile Now" button in the dashboard.
 *
 * Why this matters: Webhooks are not guaranteed delivery. A payment can
 * succeed but the webhook never arrive (network issue, timeout). This job
 * catches those cases by polling Razorpay directly.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { fetchRazorpayOrder, fetchPaymentsForOrder } from "@/lib/razorpay";
import { logAction } from "@/lib/auditLog";

const STUCK_THRESHOLD_MINUTES = 5; // Orders stuck "attempted" longer than this

export async function POST() {
  const startedAt = new Date();
  const results: Array<{
    orderId: string;
    razorpayOrderId: string;
    wasStatus: string;
    nowStatus: string;
    action: string;
  }> = [];

  try {
    // Find all orders in "created" or "attempted" state older than threshold
    const thresholdTime = new Date(
      Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000
    );

    const stuckOrders = await prisma.order.findMany({
      where: {
        status: { in: ["created", "attempted"] },
        createdAt: { lt: thresholdTime },
        razorpayOrderId: { not: null },
      },
    });

    await logAction({
      actor: "reconciler",
      tool: "reconcile_started",
      input: {
        stuckOrderCount: stuckOrders.length,
        thresholdMinutes: STUCK_THRESHOLD_MINUTES,
        triggeredAt: startedAt.toISOString(),
      },
      reason: `Reconciliation started. Found ${stuckOrders.length} orders to check.`,
    });

    for (const order of stuckOrders) {
      if (!order.razorpayOrderId) continue;

      try {
        const rzOrder = await fetchRazorpayOrder(order.razorpayOrderId);
        let newStatus = order.status;
        let action = "no_change";

        if (rzOrder.status === "paid") {
          // Try to get the payment ID
          let paymentId: string | null = null;
          try {
            const payments = await fetchPaymentsForOrder(order.razorpayOrderId);
            const items = (payments as { items?: Array<{ id: string; status: string }> }).items ?? [];
            const captured = items.find((p) => p.status === "captured");
            if (captured) paymentId = captured.id;
          } catch {
            // Continue even if payment fetch fails
          }

          await prisma.order.update({
            where: { id: order.id },
            data: {
              status: "paid",
              razorpayPaymentId: paymentId ?? order.razorpayPaymentId,
            },
          });

          await prisma.session.update({
            where: { id: order.sessionId },
            data: { status: "completed" },
          });

          newStatus = "paid";
          action = "corrected_to_paid";
        } else if (rzOrder.attempts === 0 && rzOrder.status === "created") {
          // No payment attempt at all — mark as failed
          await prisma.order.update({
            where: { id: order.id },
            data: { status: "failed" },
          });
          newStatus = "failed";
          action = "corrected_to_failed";
        }

        const result = {
          orderId: order.id,
          razorpayOrderId: order.razorpayOrderId,
          wasStatus: order.status,
          nowStatus: newStatus,
          action,
        };
        results.push(result);

        await logAction({
          sessionId: order.sessionId,
          actor: "reconciler",
          tool: "reconcile_order",
          input: { orderId: order.id, razorpayOrderId: order.razorpayOrderId },
          output: result,
          decision: action !== "no_change" ? "allowed" : undefined,
          reason:
            action !== "no_change"
              ? `Reconciled order ${order.id}: ${order.status} → ${newStatus}`
              : `Order ${order.id} status unchanged (${newStatus})`,
        });
      } catch (orderError) {
        results.push({
          orderId: order.id,
          razorpayOrderId: order.razorpayOrderId ?? "",
          wasStatus: order.status,
          nowStatus: order.status,
          action: `error: ${orderError instanceof Error ? orderError.message : String(orderError)}`,
        });
      }
    }

    await logAction({
      actor: "reconciler",
      tool: "reconcile_complete",
      input: { ordersProcessed: stuckOrders.length },
      output: {
        results,
        corrected: results.filter((r) => r.action !== "no_change").length,
      },
      reason: `Reconciliation complete. ${results.filter((r) => r.action !== "no_change").length} orders corrected.`,
    });

    return NextResponse.json({
      success: true,
      ordersChecked: stuckOrders.length,
      corrected: results.filter((r) => r.action !== "no_change").length,
      results,
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[/api/reconcile]", error);
    return NextResponse.json(
      {
        error: "Reconciliation failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
