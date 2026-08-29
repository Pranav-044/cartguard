/**
 * GET /api/cart?sessionId=xxx — Get cart contents
 * DELETE /api/cart — Clear cart
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import mandateConfig from "../../../../mandate.config.json";
import { validateCart, type CartItemWithProduct } from "@/lib/mandateEngine";

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get("sessionId");
    if (!sessionId) {
      return NextResponse.json(
        { error: "sessionId required" },
        { status: 400 }
      );
    }

    const cartItems = await prisma.cartItem.findMany({
      where: { sessionId },
      include: { product: true },
      orderBy: { addedAt: "asc" },
    });

    const isAgentMode = request.nextUrl.searchParams.get("actor") === "autonomous_buyer_agent";
    const mandateStatus = validateCart(
      cartItems as CartItemWithProduct[],
      mandateConfig,
      isAgentMode
    );

    const total = cartItems.reduce(
      (sum, item) => sum + item.product.price * item.quantity,
      0
    );

    return NextResponse.json({
      cartItems: cartItems.map((item) => ({
        id: item.id,
        productId: item.productId,
        quantity: item.quantity,
        isUpsell: item.isUpsell,
        product: item.product,
        lineTotal: item.product.price * item.quantity,
      })),
      total,
      totalFormatted: `₹${total}`,
      itemCount: cartItems.length,
      mandateStatus,
    });
  } catch (error) {
    console.error("[/api/cart GET]", error);
    return NextResponse.json(
      { error: "Failed to fetch cart" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { sessionId } = body;

    if (!sessionId) {
      return NextResponse.json(
        { error: "sessionId required" },
        { status: 400 }
      );
    }

    await prisma.cartItem.deleteMany({ where: { sessionId } });
    return NextResponse.json({ success: true, message: "Cart cleared" });
  } catch (error) {
    console.error("[/api/cart DELETE]", error);
    return NextResponse.json(
      { error: "Failed to clear cart" },
      { status: 500 }
    );
  }
}
