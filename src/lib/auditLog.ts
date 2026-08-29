/**
 * Audit Log
 *
 * Every agent action, mandate decision, payment event, and injection attempt
 * is logged here — before and after execution. Even a crashed agent
 * leaves a complete, readable trail.
 *
 * Fields:
 * - actor: who triggered this (human_chat, autonomous_buyer_agent, mandate_engine, webhook, reconciler)
 * - tool: what action was taken (tool name, event name)
 * - inputJson: raw inputs before execution
 * - outputJson: raw outputs after execution
 * - decision: allowed | blocked | requires_human_confirm
 * - reason: human-readable explanation
 */

import { prisma } from "@/lib/prisma";

export interface LogActionParams {
  sessionId?: string | null;
  actor: string;
  tool: string;
  input: unknown;
  output?: unknown;
  decision?: "allowed" | "blocked" | "requires_human_confirm";
  reason?: string;
}

/**
 * Log a single action to the audit trail.
 * Fire-and-forget friendly — errors are swallowed so logging never blocks the main flow.
 */
export async function logAction(params: LogActionParams): Promise<string> {
  try {
    const entry = await prisma.auditLog.create({
      data: {
        sessionId: params.sessionId ?? null,
        actor: params.actor,
        tool: params.tool,
        inputJson: JSON.stringify(params.input, null, 2),
        outputJson: params.output !== undefined
          ? JSON.stringify(params.output, null, 2)
          : null,
        decision: params.decision ?? null,
        reason: params.reason ?? null,
      },
    });
    return entry.id;
  } catch (err) {
    // Never throw from audit log — logging must not break the happy path
    console.error("[AuditLog] Failed to write:", err);
    return "error";
  }
}

/**
 * Log a pre-execution entry (input only). Returns the log ID so you can
 * update it after execution with the output.
 * Since SQLite doesn't support partial updates in a nice way here, we just
 * log twice — one BEFORE (decision: "pending") and one AFTER with result.
 */
export async function logPre(params: Omit<LogActionParams, "output" | "decision">): Promise<void> {
  await logAction({ ...params, decision: undefined });
}

/**
 * Retrieve paginated audit logs with optional filters.
 */
export async function getAuditLogs(opts?: {
  sessionId?: string;
  actor?: string;
  tool?: string;
  limit?: number;
  offset?: number;
}) {
  const where: Record<string, unknown> = {};
  if (opts?.sessionId) where.sessionId = opts.sessionId;
  if (opts?.actor) where.actor = opts.actor;
  if (opts?.tool) where.tool = opts.tool;

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: opts?.limit ?? 50,
      skip: opts?.offset ?? 0,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { entries, total };
}

/**
 * Get trust summary stats for the dashboard.
 */
export async function getTrustSummary() {
  const [
    totalActions,
    blockedActions,
    injectionAttempts,
    paymentSuccesses,
    paymentFailures,
    autonomousActions,
  ] = await Promise.all([
    prisma.auditLog.count(),
    prisma.auditLog.count({ where: { decision: "blocked" } }),
    prisma.auditLog.count({ where: { tool: "injection_detected" } }),
    prisma.auditLog.count({ where: { tool: "payment_success" } }),
    prisma.auditLog.count({ where: { tool: "payment_failed" } }),
    prisma.auditLog.count({ where: { actor: "autonomous_buyer_agent" } }),
  ]);

  return {
    totalActions,
    blockedActions,
    injectionAttempts,
    paymentSuccesses,
    paymentFailures,
    autonomousActions,
  };
}
