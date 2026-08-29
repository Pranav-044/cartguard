/**
 * GET /api/metrics — Revenue impact metrics
 *
 * Computes from session data:
 * - Upsell attach rate: % of completed carts with an agent-suggested item
 * - AOV lift: avg order value with vs. without accepted upsells
 * - Conversion funnel: sessions → cart built → checkout → paid
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  try {
    // ── Conversion Funnel ───────────────────────────────────────────────────
    const [
      totalSessions,
      sessionsWithCart,
      sessionsWithCheckout,
      paidOrders,
      failedOrders,
      refundedOrders,
      autonomousSessions,
    ] = await Promise.all([
      prisma.session.count(),
      prisma.session.count({
        where: { cartItems: { some: {} } },
      }),
      prisma.order.count(),
      prisma.order.count({ where: { status: "paid" } }),
      prisma.order.count({ where: { status: "failed" } }),
      prisma.order.count({ where: { status: "refunded" } }),
      prisma.session.count({ where: { actor: "autonomous_buyer_agent" } }),
    ]);

    const conversionFunnel = {
      sessionsStarted: totalSessions,
      cartBuilt: sessionsWithCart,
      checkoutInitiated: sessionsWithCheckout,
      paid: paidOrders,
      dropOffCartToCheckout:
        sessionsWithCart > 0
          ? Math.round(
              ((sessionsWithCart - sessionsWithCheckout) / sessionsWithCart) *
                100
            )
          : 0,
      dropOffCheckoutToPaid:
        sessionsWithCheckout > 0
          ? Math.round(
              ((sessionsWithCheckout - paidOrders) / sessionsWithCheckout) *
                100
            )
          : 0,
      overallConversionRate:
        totalSessions > 0
          ? Math.round((paidOrders / totalSessions) * 100)
          : 0,
    };

    // ── Upsell Analytics ────────────────────────────────────────────────────
    const [cartsWithUpsell, totalCarts, upsellRevenue, totalRevenue] =
      await Promise.all([
        // Carts that have at least one upsell item
        prisma.session.count({
          where: { cartItems: { some: { isUpsell: true } } },
        }),
        // Carts that have at least one item
        prisma.session.count({
          where: { cartItems: { some: {} } },
        }),
        // Revenue from paid orders where session had an upsell
        prisma.order.aggregate({
          where: {
            status: "paid",
            session: { cartItems: { some: { isUpsell: true } } },
          },
          _sum: { amount: true },
          _count: true,
        }),
        // Total revenue from all paid orders
        prisma.order.aggregate({
          where: { status: "paid" },
          _sum: { amount: true },
          _count: true,
        }),
      ]);

    const upsellAttachRate =
      totalCarts > 0
        ? Math.round((cartsWithUpsell / totalCarts) * 100)
        : 0;

    const avgOrderValueWithUpsell =
      upsellRevenue._count > 0
        ? Math.round((upsellRevenue._sum.amount ?? 0) / upsellRevenue._count)
        : 0;

    const avgOrderValueWithoutUpsell =
      totalRevenue._count - upsellRevenue._count > 0
        ? Math.round(
            ((totalRevenue._sum.amount ?? 0) -
              (upsellRevenue._sum.amount ?? 0)) /
              (totalRevenue._count - upsellRevenue._count)
          )
        : 0;

    const aovLift =
      avgOrderValueWithoutUpsell > 0
        ? Math.round(
            ((avgOrderValueWithUpsell - avgOrderValueWithoutUpsell) /
              avgOrderValueWithoutUpsell) *
              100
          )
        : 0;

    // ── Payment Metrics ─────────────────────────────────────────────────────
    const paymentSuccessRate =
      sessionsWithCheckout > 0
        ? Math.round((paidOrders / sessionsWithCheckout) * 100)
        : 0;

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      conversionFunnel,
      upsellMetrics: {
        upsellAttachRate,
        cartsWithUpsell,
        totalCarts,
        avgOrderValueWithUpsell,
        avgOrderValueWithoutUpsell,
        aovLiftPercent: aovLift,
        totalUpsellRevenue: upsellRevenue._sum.amount ?? 0,
      },
      paymentMetrics: {
        totalOrdersCreated: sessionsWithCheckout,
        paid: paidOrders,
        failed: failedOrders,
        refunded: refundedOrders,
        paymentSuccessRate,
        totalRevenue: totalRevenue._sum.amount ?? 0,
      },
      agentMetrics: {
        autonomousSessions,
        humanSessions: totalSessions - autonomousSessions,
        autonomousSessionShare:
          totalSessions > 0
            ? Math.round((autonomousSessions / totalSessions) * 100)
            : 0,
      },
    });
  } catch (error) {
    console.error("[/api/metrics GET]", error);
    return NextResponse.json(
      { error: "Failed to compute metrics" },
      { status: 500 }
    );
  }
}
