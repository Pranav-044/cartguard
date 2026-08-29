/**
 * POST /api/session — Create a new session
 * GET  /api/session?id=xxx — Get an existing session with cart
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { actor = "human_chat", goal } = body;

    const session = await prisma.session.create({
      data: {
        actor: actor as string,
        goal: goal ?? null,
        status: "active",
      },
    });

    return NextResponse.json({ session });
  } catch (error) {
    console.error("[/api/session POST]", error);
    return NextResponse.json(
      { error: "Failed to create session" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get("id");
    if (!sessionId) {
      return NextResponse.json(
        { error: "Session ID required" },
        { status: 400 }
      );
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        cartItems: {
          include: { product: true },
          orderBy: { addedAt: "asc" },
        },
        orders: {
          orderBy: { createdAt: "desc" },
          take: 5,
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    return NextResponse.json({ session });
  } catch (error) {
    console.error("[/api/session GET]", error);
    return NextResponse.json(
      { error: "Failed to fetch session" },
      { status: 500 }
    );
  }
}
