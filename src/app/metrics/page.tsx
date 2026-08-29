"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Metrics {
  generatedAt: string;
  conversionFunnel: {
    sessionsStarted: number;
    cartBuilt: number;
    checkoutInitiated: number;
    paid: number;
    dropOffCartToCheckout: number;
    dropOffCheckoutToPaid: number;
    overallConversionRate: number;
  };
  upsellMetrics: {
    upsellAttachRate: number;
    cartsWithUpsell: number;
    totalCarts: number;
    avgOrderValueWithUpsell: number;
    avgOrderValueWithoutUpsell: number;
    aovLiftPercent: number;
    totalUpsellRevenue: number;
  };
  paymentMetrics: {
    totalOrdersCreated: number;
    paid: number;
    failed: number;
    refunded: number;
    paymentSuccessRate: number;
    totalRevenue: number;
  };
  agentMetrics: {
    autonomousSessions: number;
    humanSessions: number;
    autonomousSessionShare: number;
  };
}

function MetricCard({
  value,
  label,
  suffix = "",
  prefix = "",
  color = "brand",
  description,
}: {
  value: number | string;
  label: string;
  suffix?: string;
  prefix?: string;
  color?: "brand" | "success" | "danger" | "warning" | "cyan";
  description?: string;
}) {
  const gradients: Record<string, string> = {
    brand: "var(--gradient-brand)",
    success: "var(--gradient-success)",
    danger: "var(--gradient-danger)",
    warning: "var(--gradient-warning)",
    cyan: "linear-gradient(135deg, #06b6d4, #22d3ee)",
  };

  return (
    <div className="stat-card">
      <div
        className="stat-value"
        style={{ background: gradients[color], WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}
      >
        {prefix}{value}{suffix}
      </div>
      <div className="stat-label">{label}</div>
      {description && (
        <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem", lineHeight: 1.4 }}>
          {description}
        </div>
      )}
    </div>
  );
}

function FunnelChart({ funnel }: { funnel: Metrics["conversionFunnel"] }) {
  const steps = [
    { label: "Sessions Started", value: funnel.sessionsStarted, icon: "👥", color: "var(--purple-400)" },
    { label: "Cart Built", value: funnel.cartBuilt, icon: "🛒", color: "var(--blue-400)" },
    { label: "Checkout Initiated", value: funnel.checkoutInitiated, icon: "💳", color: "var(--cyan-400)" },
    { label: "Payment Completed", value: funnel.paid, icon: "✅", color: "var(--emerald-400)" },
  ];

  const maxVal = Math.max(...steps.map((s) => s.value), 1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {steps.map((step, i) => (
        <div key={step.label} className="funnel-step">
          <div
            className="funnel-icon"
            style={{ background: `${step.color}22`, border: `1px solid ${step.color}55` }}
          >
            {step.icon}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
              <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>{step.label}</span>
              <span style={{ fontSize: "0.875rem", fontWeight: 800, color: step.color }}>
                {step.value}
                {i > 0 && steps[i - 1].value > 0 && (
                  <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginLeft: "0.4rem" }}>
                    ({Math.round((step.value / steps[i - 1].value) * 100)}%)
                  </span>
                )}
              </span>
            </div>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{
                  width: `${(step.value / maxVal) * 100}%`,
                  background: `linear-gradient(90deg, ${step.color}aa, ${step.color})`,
                }}
              />
            </div>
          </div>
        </div>
      ))}
      <div style={{
        display: "flex",
        justifyContent: "flex-end",
        marginTop: "0.25rem",
      }}>
        <span style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
          Overall conversion: <strong style={{ color: "var(--emerald-400)" }}>{funnel.overallConversionRate}%</strong>
        </span>
      </div>
    </div>
  );
}

function UpsellBar({ withUpsell, withoutUpsell }: { withUpsell: number; withoutUpsell: number }) {
  const max = Math.max(withUpsell, withoutUpsell, 1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>With AI upsell</span>
          <span style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--emerald-400)" }}>₹{withUpsell}</span>
        </div>
        <div className="progress-bar" style={{ height: 8 }}>
          <div className="progress-fill" style={{ width: `${(withUpsell / max) * 100}%`, background: "var(--gradient-success)" }} />
        </div>
      </div>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.4rem" }}>
          <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Without upsell</span>
          <span style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--text-secondary)" }}>₹{withoutUpsell}</span>
        </div>
        <div className="progress-bar" style={{ height: 8 }}>
          <div className="progress-fill" style={{ width: `${(withoutUpsell / max) * 100}%`, background: "linear-gradient(90deg, var(--purple-500), var(--blue-500))" }} />
        </div>
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = () =>
      fetch("/api/metrics")
        .then((r) => r.json())
        .then((d) => { setMetrics(d); setLoading(false); })
        .catch(() => setLoading(false));

    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <nav className="nav">
          <Link href="/" className="nav-brand"><span className="logo-icon">🛡️</span>CartGuard</Link>
          <div className="nav-links">
            <Link href="/" className="nav-link">Chat</Link>
            <Link href="/audit" className="nav-link">Audit Trail</Link>
            <Link href="/metrics" className="nav-link active">Metrics</Link>
          </div>
        </nav>
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ textAlign: "center", color: "var(--text-muted)" }}>
            <div style={{ fontSize: "2rem", marginBottom: "1rem" }} className="animate-spin">⟳</div>
            Loading metrics...
          </div>
        </div>
      </div>
    );
  }

  const m = metrics;

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <nav className="nav">
        <Link href="/" className="nav-brand">
          <span className="logo-icon">🛡️</span>
          CartGuard
          <span className="nav-badge">DEMO</span>
        </Link>
        <div className="nav-links">
          <Link href="/" className="nav-link">Chat</Link>
          <Link href="/audit" className="nav-link">Audit Trail</Link>
          <Link href="/metrics" className="nav-link active">Metrics</Link>
        </div>
      </nav>

      <main style={{ flex: 1, padding: "2rem", maxWidth: 1200, margin: "0 auto", width: "100%" }}>
        <div style={{ marginBottom: "2rem" }}>
          <h1 style={{ marginBottom: "0.5rem" }}>
            <span className="text-gradient">Revenue Impact</span>
          </h1>
          <p>
            Measuring how CartGuard&apos;s AI agent grows merchant revenue through intelligent upsells and conversion optimization.
            {m && (
              <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "var(--text-muted)" }}>
                Updated {new Date(m.generatedAt).toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>

        {!m ? (
          <div style={{ textAlign: "center", padding: "4rem", color: "var(--text-muted)" }}>
            No data yet. Start a chat session to generate metrics!
          </div>
        ) : (
          <>
            {/* Key metrics */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "0.875rem", marginBottom: "2rem" }}>
              <MetricCard
                value={m.upsellMetrics.upsellAttachRate}
                suffix="%"
                label="Upsell Attach Rate"
                description="% of carts with an AI-suggested item"
                color="brand"
              />
              <MetricCard
                value={m.upsellMetrics.aovLiftPercent >= 0 ? `+${m.upsellMetrics.aovLiftPercent}` : m.upsellMetrics.aovLiftPercent}
                suffix="%"
                label="AOV Lift"
                description="Average order value increase from upsells"
                color={m.upsellMetrics.aovLiftPercent >= 0 ? "success" : "danger"}
              />
              <MetricCard
                value={m.conversionFunnel.overallConversionRate}
                suffix="%"
                label="Overall Conversion"
                description="Sessions that resulted in a payment"
                color="cyan"
              />
              <MetricCard
                value={m.paymentMetrics.paymentSuccessRate}
                suffix="%"
                label="Payment Success Rate"
                color="success"
                description="Checkouts that completed payment"
              />
              <MetricCard
                value={m.paymentMetrics.totalRevenue}
                prefix="₹"
                label="Total Revenue"
                color="brand"
                description="Sum of all paid orders"
              />
              <MetricCard
                value={m.agentMetrics.autonomousSessionShare}
                suffix="%"
                label="Autonomous Sessions"
                color="cyan"
                description="Sessions driven by buyer agent"
              />
            </div>

            {/* Two-column layout */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem", marginBottom: "1.25rem" }}>
              {/* Conversion Funnel */}
              <div className="card" style={{ padding: "1.5rem" }}>
                <h2 style={{ fontSize: "1rem", marginBottom: "1.25rem" }}>
                  Conversion Funnel
                </h2>
                <FunnelChart funnel={m.conversionFunnel} />
              </div>

              {/* AOV Lift */}
              <div className="card" style={{ padding: "1.5rem" }}>
                <h2 style={{ fontSize: "1rem", marginBottom: "0.5rem" }}>
                  Average Order Value Lift
                </h2>
                <p style={{ fontSize: "0.8rem", marginBottom: "1.25rem" }}>
                  AI upsell suggestions vs. unassisted carts
                </p>
                <UpsellBar
                  withUpsell={m.upsellMetrics.avgOrderValueWithUpsell}
                  withoutUpsell={m.upsellMetrics.avgOrderValueWithoutUpsell}
                />
                {m.upsellMetrics.aovLiftPercent !== 0 && (
                  <div style={{
                    marginTop: "1rem",
                    padding: "0.75rem",
                    background: m.upsellMetrics.aovLiftPercent > 0 ? "rgba(52,211,153,0.1)" : "rgba(251,113,133,0.1)",
                    border: `1px solid ${m.upsellMetrics.aovLiftPercent > 0 ? "var(--border-success)" : "var(--border-danger)"}`,
                    borderRadius: "var(--radius-sm)",
                    fontSize: "0.8rem",
                    textAlign: "center",
                  }}>
                    <strong style={{ color: m.upsellMetrics.aovLiftPercent > 0 ? "var(--emerald-400)" : "var(--rose-400)", fontSize: "1.1rem" }}>
                      {m.upsellMetrics.aovLiftPercent >= 0 ? "+" : ""}{m.upsellMetrics.aovLiftPercent}%
                    </strong>
                    <span style={{ color: "var(--text-secondary)", marginLeft: "0.5rem" }}>AOV lift from AI upsells</span>
                  </div>
                )}
              </div>
            </div>

            {/* Payment breakdown + agent breakdown */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem" }}>
              {/* Payment breakdown */}
              <div className="card" style={{ padding: "1.5rem" }}>
                <h2 style={{ fontSize: "1rem", marginBottom: "1.25rem" }}>Payment Breakdown</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {[
                    { label: "Paid", value: m.paymentMetrics.paid, color: "var(--emerald-400)", icon: "✅" },
                    { label: "Failed", value: m.paymentMetrics.failed, color: "var(--rose-400)", icon: "❌" },
                    { label: "Refunded", value: m.paymentMetrics.refunded, color: "var(--amber-400)", icon: "↩️" },
                  ].map((item) => {
                    const total = m.paymentMetrics.totalOrdersCreated || 1;
                    return (
                      <div key={item.label} style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                        <span style={{ fontSize: "1rem" }}>{item.icon}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
                            <span style={{ fontSize: "0.8rem" }}>{item.label}</span>
                            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: item.color }}>{item.value}</span>
                          </div>
                          <div className="progress-bar">
                            <div
                              className="progress-fill"
                              style={{ width: `${(item.value / total) * 100}%`, background: item.color }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Agent breakdown */}
              <div className="card" style={{ padding: "1.5rem" }}>
                <h2 style={{ fontSize: "1rem", marginBottom: "1.25rem" }}>Session Type</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {[
                    { label: "Human (Chat UI)", value: m.agentMetrics.humanSessions, color: "var(--blue-400)", icon: "👤" },
                    { label: "Autonomous Agent", value: m.agentMetrics.autonomousSessions, color: "var(--cyan-400)", icon: "🤖" },
                  ].map((item) => {
                    const total = m.agentMetrics.humanSessions + m.agentMetrics.autonomousSessions || 1;
                    return (
                      <div key={item.label} style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                        <span style={{ fontSize: "1rem" }}>{item.icon}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.3rem" }}>
                            <span style={{ fontSize: "0.8rem" }}>{item.label}</span>
                            <span style={{ fontSize: "0.8rem", fontWeight: 700, color: item.color }}>
                              {item.value} ({Math.round((item.value / total) * 100)}%)
                            </span>
                          </div>
                          <div className="progress-bar">
                            <div className="progress-fill" style={{ width: `${(item.value / total) * 100}%`, background: item.color }} />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{
                  marginTop: "1.5rem",
                  padding: "0.875rem",
                  background: "rgba(34,211,238,0.08)",
                  border: "1px solid rgba(34,211,238,0.25)",
                  borderRadius: "var(--radius-sm)",
                  fontSize: "0.78rem",
                  color: "var(--text-secondary)",
                  lineHeight: 1.5,
                }}>
                  🤖 <strong style={{ color: "var(--cyan-400)" }}>Autonomous agents</strong> transact with zero human clicks — proving the merchant is AI-transactable.
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
