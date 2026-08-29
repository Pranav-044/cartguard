/**
 * GET  /api/audit — Paginated audit log with filters
 * Stats: /api/audit?stats=true — trust summary numbers
 */

import { NextRequest, NextResponse } from "next/server";
import { getAuditLogs, getTrustSummary } from "@/lib/auditLog";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;

    // Trust summary mode
    if (searchParams.get("stats") === "true") {
      const summary = await getTrustSummary();
      return NextResponse.json({ summary });
    }

    const sessionId = searchParams.get("sessionId") ?? undefined;
    const actor = searchParams.get("actor") ?? undefined;
    const tool = searchParams.get("tool") ?? undefined;
    const limit = parseInt(searchParams.get("limit") ?? "50");
    const offset = parseInt(searchParams.get("offset") ?? "0");

    const { entries, total } = await getAuditLogs({
      sessionId,
      actor,
      tool,
      limit,
      offset,
    });

    return NextResponse.json({
      entries,
      total,
      limit,
      offset,
      hasMore: offset + entries.length < total,
    });
  } catch (error) {
    console.error("[/api/audit GET]", error);
    return NextResponse.json(
      { error: "Failed to fetch audit log" },
      { status: 500 }
    );
  }
}
