"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Link from "next/link";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

interface CartItem {
  id: string;
  product: {
    id: string;
    name: string;
    price: number;
    category: string;
  };
  quantity: number;
  isUpsell: boolean;
  lineTotal: number;
}

interface MandateStatus {
  totalAmount: number;
  decision: { allowed: boolean; requiresHumanConfirm?: boolean; reason?: string };
  violations: string[];
}

interface CheckoutState {
  orderId?: string;
  razorpayOrderId?: string;
  amount?: number;
  status: "idle" | "loading" | "ready" | "success" | "failed" | "requires_confirm";
  message?: string;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Razorpay: any;
  }
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "👟 Welcome to **CartGuard** — your AI running-gear assistant.\n\nI can help you find the perfect gear for your 5K run under ₹4,000. Try asking me:\n• *\"Find me trail running shoes under ₹2500\"*\n• *\"What running gear do I need for a 5K?\"*\n• *\"Show me the UltraTrail Pro X\"* (triggers injection demo 😈)\n\nAll purchases are gated by a **deterministic mandate engine** — I never authorize payments, it does.",
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [cartTotal, setCartTotal] = useState(0);
  const [mandateStatus, setMandateStatus] = useState<MandateStatus | null>(null);
  const [checkout, setCheckout] = useState<CheckoutState>({ status: "idle" });
  const [showCart, setShowCart] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const conversationHistory = messages
    .filter((m) => m.id !== "welcome")
    .map((m) => ({ role: m.role, content: m.content }));

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);

  const addMessage = useCallback((msg: Omit<Message, "id" | "timestamp">) => {
    setMessages((prev) => [
      ...prev,
      { ...msg, id: `msg_${Date.now()}_${Math.random()}`, timestamp: new Date() },
    ]);
  }, []);

  const openRazorpayCheckout = useCallback(
    (orderData: { razorpayOrderId: string; orderId: string; amount: number; keyId?: string }) => {
      if (!window.Razorpay) {
        addMessage({ role: "assistant", content: "⚠️ Razorpay SDK not loaded. Please refresh." });
        return;
      }

      const options = {
        key: orderData.keyId ?? process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: "INR",
        name: "CartGuard Demo Store",
        description: "Running Gear Purchase",
        order_id: orderData.razorpayOrderId,
        modal: {
          ondismiss: () => {
            setCheckout({ status: "idle" });
            addMessage({
              role: "assistant",
              content: "Payment window closed. Your cart is still saved — ready when you are!",
            });
          },
        },
        handler: async (response: {
          razorpay_payment_id: string;
          razorpay_order_id: string;
          razorpay_signature: string;
        }) => {
          setCheckout({ status: "success" });
          // Verify signature server-side
          try {
            await fetch("/api/checkout/verify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
                orderId: orderData.orderId,
              }),
            });
          } catch (_err) { /* Webhook will handle this anyway */ }
          addMessage({
            role: "assistant",
            content: `✅ **Payment Successful!**\n\n**Payment ID**: \`${response.razorpay_payment_id}\`\n**Order ID**: \`${orderData.orderId}\`\n\nYour running gear is on its way! 🎉\n\nWant to check your order status or request a refund? Just ask me.`,
          });
        },
        prefill: { name: "Demo User", email: "demo@cartguard.dev" },
        theme: { color: "#8b5cf6" },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", (response: { error: { description: string } }) => {
        setCheckout({ status: "failed", message: response.error.description });
        addMessage({
          role: "assistant",
          content: `❌ **Payment Declined**\n\n${response.error.description}\n\nIf you're testing, try card **4111 1111 1111 1111** with any future expiry and CVV 123.\n\nShould I retry checkout with a different card?`,
        });
      });
      rzp.open();
    },
    [addMessage]
  );

  const initiateCheckout = useCallback(
    async (attemptNumber = 1) => {
      if (!sessionId || cartItems.length === 0) return;
      setCheckout({ status: "loading" });

      const idempotencyKey = `session:${sessionId}:attempt:${attemptNumber}`;

      try {
        const res = await fetch("/api/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, idempotencyKey, actor: "human_chat" }),
        });

        const data = await res.json();

        if (res.status === 202 && data.requiresHumanConfirm) {
          setCheckout({ status: "requires_confirm", message: data.reason, amount: data.totalAmount });
          addMessage({
            role: "assistant",
            content: `🛡️ **Human Confirmation Required**\n\nYour cart total of ₹${data.totalAmount} exceeds the auto-approve threshold.\n\n${data.reason}\n\nPlease click **Confirm Purchase** to proceed.`,
          });
          return;
        }

        if (!res.ok) {
          setCheckout({ status: "failed", message: data.error });
          addMessage({
            role: "assistant",
            content: `❌ **Checkout blocked**: ${data.error}\n\n${data.violations?.join(", ") ?? ""}`,
          });
          return;
        }

        setCheckout({ status: "ready", orderId: data.orderId, razorpayOrderId: data.razorpayOrderId, amount: data.amount });
        openRazorpayCheckout(data);
      } catch (err) {
        setCheckout({ status: "failed", message: String(err) });
      }
    },
    [sessionId, cartItems, addMessage, openRazorpayCheckout]
  );

  const humanConfirmCheckout = useCallback(async () => {
    if (!sessionId) return;
    setCheckout({ status: "loading" });
    const idempotencyKey = `session:${sessionId}:attempt:1:confirmed`;
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, idempotencyKey, actor: "human_chat_confirmed" }),
    });
    const data = await res.json();
    if (res.ok && data.razorpayOrderId) {
      setCheckout({ status: "ready", ...data });
      openRazorpayCheckout(data);
    } else {
      setCheckout({ status: "failed", message: data.error });
    }
  }, [sessionId, openRazorpayCheckout]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    addMessage({ role: "user", content: text });
    setIsLoading(true);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: text, actor: "human_chat", conversationHistory }),
      });
      const data = await res.json();

      if (data.sessionId && !sessionId) setSessionId(data.sessionId);
      if (data.cartItems) setCartItems(data.cartItems);
      if (data.cartTotal !== undefined) setCartTotal(data.cartTotal);

      if (data.sessionId && data.cartItems?.length > 0) {
        fetch(`/api/cart?sessionId=${data.sessionId}`)
          .then((r) => r.json())
          .then((d) => { if (d.mandateStatus) setMandateStatus(d.mandateStatus); })
          .catch(() => {});
      }

      addMessage({ role: "assistant", content: data.message || "I have processed your request." });
    } catch (err) {
      addMessage({ role: "assistant", content: "⚠️ Something went wrong. Please try again." });
      console.error(err);
    } finally {
      setIsLoading(false);
      inputRef.current?.focus();
    }
  }, [input, isLoading, sessionId, conversationHistory, addMessage]);

  const getMandateClass = () => {
    if (!mandateStatus) return "";
    if (!mandateStatus.decision.allowed) return "blocked";
    if (mandateStatus.decision.requiresHumanConfirm) return "warning";
    return "allowed";
  };

  const getMandateIcon = () => {
    if (!mandateStatus) return "🛡️";
    if (!mandateStatus.decision.allowed) return "🚫";
    if (mandateStatus.decision.requiresHumanConfirm) return "⚠️";
    return "✅";
  };

  const handleRefund = useCallback(async () => {
    if (!sessionId) return;
    const sessionRes = await fetch(`/api/session?id=${sessionId}`);
    const sessionData = await sessionRes.json();
    const latestOrder = sessionData.session?.orders?.[0];
    if (!latestOrder) return;

    const res = await fetch("/api/refund", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: latestOrder.id }),
    });
    const data = await res.json();
    if (res.ok) {
      setCheckout({ status: "idle" });
      addMessage({
        role: "assistant",
        content: `↩️ **Refund initiated!**\n\nRefund ID: \`${data.refundId}\`\n\nYour ₹${data.amount} refund has been processed. Full lifecycle: created -> paid -> refunded (done)`,
      });
    }
  }, [sessionId, addMessage]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Navigation */}
      <nav className="nav">
        <Link href="/" className="nav-brand">
          <span className="logo-icon">🛡️</span>
          CartGuard
          <span className="nav-badge">DEMO</span>
        </Link>
        <div className="nav-links">
          <Link href="/" className="nav-link active">Chat</Link>
          <Link href="/audit" className="nav-link">Audit Trail</Link>
          <Link href="/metrics" className="nav-link">Metrics</Link>
          {sessionId && (
            <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginLeft: "0.5rem", fontFamily: "monospace" }}>
              {sessionId.slice(0, 8)}…
            </span>
          )}
        </div>
      </nav>

      {/* Main layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Chat area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Messages */}
          <div
            id="chat-messages"
            style={{ flex: 1, overflowY: "auto", padding: "1.5rem", display: "flex", flexDirection: "column", gap: "1rem" }}
          >
            {messages.map((msg) => (
              <div
                key={msg.id}
                className="animate-fade-in"
                style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start", gap: "0.375rem" }}
              >
                {msg.role === "assistant" && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginLeft: "0.25rem" }}>
                    <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--gradient-brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px" }}>🛡️</span>
                    <span style={{ fontSize: "0.75rem", color: "var(--text-muted)", fontWeight: 600 }}>CartGuard AI</span>
                  </div>
                )}
                <div className={`chat-bubble chat-bubble-${msg.role}`}>
                  <div
                    style={{ whiteSpace: "pre-wrap" }}
                    dangerouslySetInnerHTML={{
                      __html: msg.content
                        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
                        .replace(/`(.+?)`/g, "<code style='background:rgba(139,92,246,0.2);padding:1px 5px;border-radius:4px;font-size:0.85em'>$1</code>")
                        .replace(/\*(.+?)\*/g, "<em>$1</em>")
                        .replace(/\n/g, "<br/>"),
                    }}
                  />
                </div>
                <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", margin: "0 0.25rem" }}>
                  {msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            ))}

            {isLoading && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem" }}>
                <span style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--gradient-brand)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", flexShrink: 0 }}>🛡️</span>
                <div className="chat-bubble chat-bubble-assistant">
                  <div className="typing-indicator">
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                  </div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Checkout confirm banner */}
          {checkout.status === "requires_confirm" && (
            <div style={{ margin: "0 1.5rem", padding: "1rem 1.25rem", background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.3)", borderRadius: "var(--radius-md)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <div>
                <div style={{ fontWeight: 700, color: "var(--amber-400)", fontSize: "0.875rem" }}>⚠️ Human Confirmation Required</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}>{checkout.message}</div>
              </div>
              <button id="confirm-purchase-btn" className="btn btn-primary" style={{ flexShrink: 0 }} onClick={humanConfirmCheckout}>
                Confirm Purchase
              </button>
            </div>
          )}

          {/* Input */}
          <div style={{ padding: "1rem 1.5rem", borderTop: "1px solid var(--border)" }}>
            <div style={{ display: "flex", gap: "0.75rem" }}>
              <input
                ref={inputRef}
                id="chat-input"
                className="input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder="Ask about running gear... (try 'show me UltraTrail Pro X')"
                disabled={isLoading}
                style={{ flex: 1 }}
              />
              <button id="send-btn" className="btn btn-primary" onClick={sendMessage} disabled={!input.trim() || isLoading}>
                {isLoading ? "..." : "Send"}
              </button>
            </div>
            <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {["Trail running shoes under ₹2500", "5K starter kit under ₹4000", "Show me UltraTrail Pro X", "Energy gels"].map((q) => (
                <button key={q} className="btn btn-secondary btn-sm" onClick={() => { setInput(q); inputRef.current?.focus(); }} style={{ fontSize: "0.75rem" }}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Cart sidebar */}
        {showCart && (
          <div style={{ width: 320, borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "rgba(6,6,18,0.6)", backdropFilter: "blur(12px)" }}>
            <div style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 700, fontSize: "0.9rem" }}>🛒 Cart</div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                {cartItems.length > 0 && (
                  <span style={{ background: "var(--gradient-brand)", color: "white", borderRadius: "10px", fontSize: "0.7rem", fontWeight: 700, padding: "0.15rem 0.5rem" }}>
                    {cartItems.reduce((s, i) => s + i.quantity, 0)}
                  </span>
                )}
                <button className="btn btn-secondary btn-sm" onClick={() => setShowCart(false)} style={{ padding: "0.25rem 0.5rem", fontSize: "0.75rem" }}>✕</button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "1rem" }}>
              {cartItems.length === 0 ? (
                <div style={{ textAlign: "center", padding: "2rem 1rem", color: "var(--text-muted)" }}>
                  <div style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🛒</div>
                  <div style={{ fontSize: "0.8rem" }}>Your cart is empty.<br />Ask me to find running gear!</div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {cartItems.map((item) => (
                    <div key={item.id} className="product-card" style={{ cursor: "default" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: "0.5rem" }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: "0.8rem", lineHeight: 1.3 }}>{item.product.name}</div>
                          <div style={{ fontSize: "0.72rem", color: "var(--text-muted)", marginTop: "0.2rem" }}>
                            {item.product.category} × {item.quantity}
                          </div>
                          {item.isUpsell && (
                            <span className="badge badge-info" style={{ marginTop: "0.3rem", fontSize: "0.65rem" }}>🤖 AI upsell</span>
                          )}
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0 }}>
                          <div className="product-price" style={{ fontSize: "0.875rem" }}>₹{item.lineTotal}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {cartItems.length > 0 && (
              <div style={{ padding: "1rem", borderTop: "1px solid var(--border)" }}>
                {/* Budget bar */}
                <div style={{ marginBottom: "0.75rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", marginBottom: "0.4rem" }}>
                    <span style={{ color: "var(--text-secondary)" }}>Budget used</span>
                    <span style={{ fontWeight: 700 }}>₹{cartTotal} / ₹4,000</span>
                  </div>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${Math.min((cartTotal / 4000) * 100, 100)}%`, background: cartTotal > 4000 ? "var(--gradient-danger)" : "var(--gradient-brand)" }} />
                  </div>
                </div>

                {/* Mandate status */}
                {mandateStatus && (
                  <div className={`mandate-bar ${getMandateClass()}`} style={{ marginBottom: "0.75rem" }}>
                    {getMandateIcon()}
                    <span>
                      {!mandateStatus.decision.allowed
                        ? `Blocked: ${mandateStatus.violations[0] ?? "Mandate failed"}`
                        : mandateStatus.decision.requiresHumanConfirm
                        ? "Requires your approval"
                        : "Mandate approved ✓"}
                    </span>
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.75rem" }}>
                  <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>Total</span>
                  <span style={{ fontWeight: 800, fontSize: "1.1rem", color: "var(--purple-400)" }}>₹{cartTotal}</span>
                </div>

                <button
                  id="checkout-btn"
                  className="btn btn-primary"
                  style={{ width: "100%", justifyContent: "center" }}
                  onClick={() => initiateCheckout(1)}
                  disabled={checkout.status === "loading" || checkout.status === "success"}
                >
                  {checkout.status === "loading" ? "Processing…" :
                   checkout.status === "success" ? "✅ Paid" :
                   "Checkout with Razorpay →"}
                </button>

                {checkout.status === "success" && (
                  <button id="refund-btn" className="btn btn-danger btn-sm" style={{ width: "100%", marginTop: "0.5rem", justifyContent: "center" }} onClick={handleRefund}>
                    ↩️ Refund this order
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {!showCart && (
          <button
            id="show-cart-btn"
            className="btn btn-secondary"
            style={{ position: "fixed", bottom: "6rem", right: "1.5rem", borderRadius: "50px", boxShadow: "var(--shadow-lg)" }}
            onClick={() => setShowCart(true)}
          >
            🛒 {cartItems.length > 0 && `${cartItems.reduce((s, i) => s + i.quantity, 0)} · ₹${cartTotal}`}
          </button>
        )}
      </div>
    </div>
  );
}
