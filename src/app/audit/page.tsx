"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

interface AuditEntry {
  id: string;
  sessionId: string | null;
  actor: string;
  tool: string;
  inputJson: string;
  outputJson: string | null;
  decision: string | null;
  reason: string | null;
  createdAt: string;
}

interface TrustSummary {
  totalActions: number;
  blockedActions: number;
  injectionAttempts: number;
  paymentSuccesses: number;
  paymentFailures: number;
  autonomousActions: number;
}

const ACTOR_COLORS: Record<string, string> = {
  human_chat: "var(--blue-400)",
  autonomous_buyer_agent: "var(--cyan-400)",
  mandate_engine: "var(--amber-400)",
  webhook: "var(--emerald-400)",
  reconciler: "var(--orange-400)",
  system: "var(--text-muted)",
};

const DECISION_STYLES: Record<string, string> = {
  allowed: "badge-allowed",
  blocked: "badge-blocked",
  requires_human_confirm: "badge-warning",
};

function ActorBadge({ actor }: { actor: string }) {
  const color = ACTOR_COLORS[actor] ?? "var(--text-secondary)";
  const emoji =
    actor === "human_chat" ? "👤" :
    actor === "autonomous_buyer_agent" ? "🤖" :
    actor === "mandate_engine" ? "🛡️" :
    actor === "webhook" ? "🔔" :
    actor === "reconciler" ? "🔄" : "⚙️";

  return (
    <span style={{
      color,
      fontSize: "0.75rem",
      fontWeight: 700,
      display: "flex",
      alignItems: "center",
      gap: "0.25rem",
      whiteSpace: "nowrap",
    }}>
      {emoji} {actor}
    </span>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false);
  let input: unknown = null;
  let output: unknown = null;

  try { input = JSON.parse(entry.inputJson); } catch { input = entry.inputJson; }
  try { output = entry.outputJson ? JSON.parse(entry.outputJson) : null; } catch { output = entry.outputJson; }

  const isInjection = entry.tool.includes("injection");
  const isBlocked = entry.decision === "blocked";

  return (
    <div
      className={`audit-entry ${expanded ? "expanded" : ""}`}
      style={{
        borderColor: isInjection ? "rgba(251, 113, 133, 0.4)" :
                     isBlocked ? "rgba(251, 113, 133, 0.2)" : undefined,
        animationName: "fadeIn",
        animationDuration: "0.3s",
        animationFillMode: "forwards",
      }}
      onClick={() => setExpanded(!expanded)}
    >
      {/* Indicator dot */}
      <div style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: isInjection ? "var(--rose-400)" :
                    isBlocked ? "rgba(251, 113, 133, 0.7)" :
                    entry.decision === "allowed" ? "var(--emerald-400)" :
                    entry.decision === "requires_human_confirm" ? "var(--amber-400)" :
                    "var(--text-muted)",
        flexShrink: 0,
        boxShadow: isInjection ? "0 0 8px var(--rose-400)" : undefined,
      }} />

      {/* Time */}
      <span className="audit-time">
        {new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </span>

      {/* Actor */}
      <ActorBadge actor={entry.actor} />

      {/* Tool */}
      <span className="audit-tool">{entry.tool}</span>

      {/* Decision badge */}
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
        {entry.decision && (
          <span className={`badge ${DECISION_STYLES[entry.decision] ?? "badge-info"}`}>
            {entry.decision}
          </span>
        )}
        {isInjection && (
          <span className="badge badge-blocked" style={{ fontSize: "0.65rem" }}>
            ⚠️ INJECTION
          </span>
        )}
        <span style={{ fontSize: "0.9rem", color: "var(--text-muted)" }}>
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div
          style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--border)", paddingTop: "1rem", marginTop: "0.25rem" }}
          onClick={(e) => e.stopPropagation()}
        >
          {entry.reason && (
            <div style={{
              padding: "0.625rem 0.875rem",
              background: "rgba(139, 92, 246, 0.08)",
              border: "1px solid rgba(139, 92, 246, 0.2)",
              borderRadius: "var(--radius-sm)",
              fontSize: "0.8rem",
              color: "var(--text-secondary)",
              marginBottom: "0.75rem",
              lineHeight: 1.5,
            }}>
              💬 {entry.reason}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <div>
              <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-muted)", marginBottom: "0.4rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                INPUT
              </div>
              <pre className="audit-json">{JSON.stringify(input, null, 2)}</pre>
            </div>
            {output !== null && (
              <div>
                <div style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--text-muted)", marginBottom: "0.4rem", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  OUTPUT
                </div>
                <pre className="audit-json">{JSON.stringify(output, null, 2)}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [summary, setSummary] = useState<TrustSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<{ actor: string; decision: string }>({ actor: "", decision: "" });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [reconciling, setReconciling] = useState(false);

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter.actor) params.set("actor", filter.actor);
    if (filter.decision) params.set("decision", filter.decision);
    params.set("limit", "100");

    const [logsRes, statsRes] = await Promise.all([
      fetch(`/api/audit?${params}`),
      fetch("/api/audit?stats=true"),
    ]);

    const [logsData, statsData] = await Promise.all([logsRes.json(), statsRes.json()]);

    setEntries(logsData.entries ?? []);
    setSummary(statsData.summary ?? null);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    fetchData();
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 3000);
    return () => clearInterval(interval);
  }, [fetchData, autoRefresh]);

  const handleReconcile = async () => {
    setReconciling(true);
    await fetch("/api/reconcile", { method: "POST" });
    await fetchData();
    setReconciling(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Nav */}
      <nav className="nav">
        <Link href="/" className="nav-brand">
          <span className="logo-icon">🛡️</span>
          CartGuard
          <span className="nav-badge">DEMO</span>
        </Link>
        <div className="nav-links">
          <Link href="/" className="nav-link">Chat</Link>
          <Link href="/audit" className="nav-link active">Audit Trail</Link>
          <Link href="/metrics" className="nav-link">Metrics</Link>
        </div>
      </nav>

      <main style={{ flex: 1, padding: "2rem", maxWidth: 1400, margin: "0 auto", width: "100%" }}>
        <div style={{ marginBottom: "2rem" }}>
          <h1 style={{ marginBottom: "0.5rem" }}>
            <span className="text-gradient">Audit Trail</span>
          </h1>
          <p>Every agent action, mandate decision, and payment event — logged in real time.</p>
        </div>

        {/* Trust Summary */}
        {summary && (
          <div style={{ marginBottom: "2rem" }}>
            <h2 style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "1rem" }}>
              Trust Summary
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "0.875rem" }}>
              <div className="stat-card">
                <div className="stat-value">{summary.totalActions}</div>
                <div className="stat-label">Total Actions</div>
              </div>
              <div className="stat-card" style={{ borderColor: summary.blockedActions > 0 ? "rgba(251,113,133,0.3)" : undefined }}>
                <div className="stat-value" style={{ background: "var(--gradient-danger)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  {summary.blockedActions}
                </div>
                <div className="stat-label">Blocked by Mandate</div>
              </div>
              <div className="stat-card" style={{ borderColor: summary.injectionAttempts > 0 ? "rgba(251,113,133,0.5)" : undefined }}>
                <div className="stat-value" style={{ background: "var(--gradient-danger)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  {summary.injectionAttempts}
                </div>
                <div className="stat-label">Injection Attempts</div>
                {summary.injectionAttempts > 0 && (
                  <div style={{ fontSize: "0.7rem", color: "var(--rose-400)" }}>⚠️ All blocked</div>
                )}
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ background: "var(--gradient-success)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  {summary.paymentSuccesses}
                </div>
                <div className="stat-label">Payments Succeeded</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ background: "var(--gradient-danger)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  {summary.paymentFailures}
                </div>
                <div className="stat-label">Payments Failed</div>
              </div>
              <div className="stat-card">
                <div className="stat-value" style={{ color: "var(--cyan-400)", background: "none", WebkitTextFillColor: "var(--cyan-400)" }}>
                  {summary.autonomousActions}
                </div>
                <div className="stat-label">Autonomous Agent Actions</div>
              </div>
            </div>
          </div>
        )}

        {/* Controls */}
        <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1.25rem", flexWrap: "wrap", alignItems: "center" }}>
          <select
            id="actor-filter"
            className="input"
            style={{ width: "auto", minWidth: 180 }}
            value={filter.actor}
            onChange={(e) => setFilter((f) => ({ ...f, actor: e.target.value }))}
          >
            <option value="">All actors</option>
            <option value="human_chat">👤 human_chat</option>
            <option value="autonomous_buyer_agent">🤖 autonomous_buyer_agent</option>
            <option value="mandate_engine">🛡️ mandate_engine</option>
            <option value="webhook">🔔 webhook</option>
            <option value="reconciler">🔄 reconciler</option>
          </select>

          <select
            id="decision-filter"
            className="input"
            style={{ width: "auto", minWidth: 180 }}
            value={filter.decision}
            onChange={(e) => setFilter((f) => ({ ...f, decision: e.target.value }))}
          >
            <option value="">All decisions</option>
            <option value="allowed">✅ Allowed</option>
            <option value="blocked">🚫 Blocked</option>
            <option value="requires_human_confirm">⚠️ Human confirm</option>
          </select>

          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <button
              id="auto-refresh-btn"
              className={`btn ${autoRefresh ? "btn-primary" : "btn-secondary"} btn-sm`}
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh ? "⏸ Live" : "▶ Resume"}
            </button>
          </div>

          <button
            id="refresh-btn"
            className="btn btn-secondary btn-sm"
            onClick={fetchData}
          >
            🔄 Refresh
          </button>

          <button
            id="reconcile-btn"
            className="btn btn-secondary btn-sm"
            onClick={handleReconcile}
            disabled={reconciling}
          >
            {reconciling ? "Reconciling..." : "⚡ Reconcile Now"}
          </button>

          <span style={{ marginLeft: "auto", fontSize: "0.75rem", color: "var(--text-muted)" }}>
            {entries.length} entries
            {autoRefresh && (
              <span style={{ color: "var(--emerald-400)", marginLeft: "0.5rem" }}>● LIVE</span>
            )}
          </span>
        </div>

        {/* Audit entries */}
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {loading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 60, borderRadius: "var(--radius-md)" }} />
            ))
          ) : entries.length === 0 ? (
            <div style={{ textAlign: "center", padding: "4rem 2rem", color: "var(--text-muted)" }}>
              <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>📋</div>
              <div>No audit entries yet. Start a chat to see the trail!</div>
            </div>
          ) : (
            entries.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))
          )}
        </div>
      </main>
    </div>
  );
}
