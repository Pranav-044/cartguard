# CartGuard — Architecture

## The Core Insight

Every AI shopping system has the same vulnerability: **the LLM is both the reasoning engine and the authorization engine**. If the LLM is convinced (by injection, jailbreak, or a clever merchant description) that a ₹50,000 watch is actually ₹500, it will authorize the wrong payment.

CartGuard separates these concerns:
- **LLM = reasoning** (what does the user want? what products match?)
- **Mandate Engine = authorization** (is this spend allowed? these are pure functions, no LLM)

---

## Request Flow: Human Chat

```mermaid
sequenceDiagram
    participant U as 👤 User (Browser)
    participant C as Chat UI (/)
    participant A as /api/agent
    participant LLM as Claude API
    participant IS as Injection Sanitizer
    participant ME as Mandate Engine
    participant DB as SQLite (Prisma)
    participant RZ as Razorpay API

    U->>C: "Trail shoes under ₹2500"
    C->>A: POST {message, sessionId, history}
    
    A->>IS: scanUserMessage(message)
    IS-->>A: {clean: true, sanitizedText}
    
    A->>LLM: claude-sonnet-4-5 + 8 tools + sanitized message
    LLM-->>A: tool_use: search_products {maxPrice: 2500}
    
    A->>DB: prisma.product.findMany({price: {lte: 2500}})
    A->>IS: scanProductForInjection(each product)
    Note over IS: Adversarial product caught here<br/>description sanitized before LLM sees it
    DB-->>A: [TrailRunner Pro X500, RoadRunner Lite 2.0, ...]
    
    A->>LLM: tool_result: [{id, name, price, ...}, ...]
    LLM-->>A: tool_use: add_to_cart {productId: "prod_trail_pro"}
    
    A->>ME: validateUpsellItem(product, currentTotal, config)
    Note over ME: Pure function. Reads product.price from DB.<br/>NEVER reads description or LLM output.
    ME-->>A: {allowed: true}
    
    A->>DB: prisma.cartItem.create(...)
    A->>DB: logAction({tool: "add_to_cart", decision: "allowed"})
    
    LLM-->>A: text: "Added TrailRunner Pro X500 (₹1,999) to your cart!"
    A-->>C: {message, cartItems, cartTotal}
    C-->>U: Updates cart sidebar + mandate status bar
```

---

## Request Flow: Checkout (Idempotent)

```mermaid
sequenceDiagram
    participant U as 👤 User
    participant C as Cart Sidebar
    participant CK as /api/checkout
    participant ME as Mandate Engine
    participant IK as Idempotency Layer
    participant DB as SQLite
    participant RZ as Razorpay API
    participant WH as /api/webhook

    U->>C: Click "Checkout with Razorpay →"
    C->>CK: POST {sessionId, idempotencyKey: "session:X:attempt:1", actor}

    CK->>DB: Load cart items (prices from DB, NEVER from client)
    CK->>ME: validateCart(cartItems, mandateConfig, isAgentMode)
    Note over ME: Recomputes total from DB prices.<br/>Checks: budget cap, per-item cap,<br/>category allowlist, human-confirm threshold.
    ME-->>CK: {allowed: true, totalAmount: 3348}

    CK->>IK: getOrCreateOrder(idempotencyKey, ...)
    Note over IK: DB unique constraint on idempotencyKey.<br/>Second call with same key returns existing order.<br/>No duplicate Razorpay API call.
    IK->>RZ: orders.create({amount: 334800, currency: "INR"})
    RZ-->>IK: {id: "order_XXXXXX", status: "created"}
    IK->>DB: INSERT Order {razorpayOrderId, idempotencyKey, status: "created"}
    IK-->>CK: {order, isExisting: false}

    CK->>DB: logAction({tool: "checkout_order_created", decision: "allowed"})
    CK-->>C: {razorpayOrderId, amount, keyId}

    C->>C: Open Razorpay Checkout.js modal
    U->>C: Enter card, pay
    RZ-->>C: handler({razorpay_payment_id, razorpay_signature})
    C->>CK: POST /verify {razorpayOrderId, paymentId, signature}
    Note over CK: HMAC-SHA256(orderId|paymentId, KEY_SECRET)<br/>Verified server-side before any state change.
    CK->>DB: UPDATE Order {status: "paid", razorpayPaymentId}

    RZ->>WH: POST /api/webhook (payment.captured)
    WH->>WH: Verify X-Razorpay-Signature header
    WH->>DB: Deduplicate by razorpay_payment_id
    WH->>DB: logAction({tool: "payment_captured"})
```

---

## Request Flow: Autonomous Buyer Agent

```mermaid
sequenceDiagram
    participant CLI as 🤖 buyer-agent CLI
    participant AG as /api/agent
    participant LLM as Claude API (Buyer)
    participant ME as Mandate Engine
    participant TP as /api/test-payment
    participant AU as /api/audit

    CLI->>AG: POST {message: "find trail shoes", actor: "autonomous_buyer_agent"}
    Note over AG,LLM: Same tool-calling loop as chat UI.<br/>Actor tag differentiates in audit log.
    AG->>LLM: Tool-calling loop
    LLM-->>AG: search_products, add_to_cart, check_mandate...
    AG->>ME: validateCart(..., isAgentMode=true)
    Note over ME: Agent mode: humanConfirmThreshold = ₹999,999<br/>No human-confirm gate for autonomous agents.
    ME-->>AG: {allowed: true}
    AG-->>CLI: {cartItems, cartTotal, toolResults}

    CLI->>AG: POST {message: "initiate checkout", ...}
    AG->>LLM: initiate_checkout tool
    LLM-->>AG: initiate_checkout({sessionId, idempotencyKey: "session:X:attempt:1"})

    Note over CLI: --fail-first flag set
    CLI->>TP: POST {simulateFailure: true, actor: "autonomous_buyer_agent"}
    TP->>AU: logAction({tool: "payment_failed", decision: "blocked"})
    TP-->>CLI: {error: "Card declined"}

    CLI->>AG: New idempotencyKey (attempt:2)
    CLI->>TP: POST {simulateFailure: false}
    TP->>AU: logAction({tool: "payment_success", decision: "allowed"})
    TP-->>CLI: {paymentId: "pay_XXXXX"}

    CLI->>CLI: Print receipt (goal, items, total, paymentId, attempts: 2)
```

---

## The 7-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 7: Agent-to-Agent                                        │
│  scripts/buyer-agent.ts — autonomous CLI buyer, zero human clicks│
│  Same APIs, different actor tag, different mandate config override│
├─────────────────────────────────────────────────────────────────┤
│  Layer 6: Revenue Metrics                                       │
│  /metrics — upsell attach rate, AOV lift, conversion funnel     │
│  Computed from real session/order data, not mocked              │
├─────────────────────────────────────────────────────────────────┤
│  Layer 5: Audit / Trust Trail                                   │
│  /audit — every action, before+after, with full JSON            │
│  logAction() called pre-execution AND post-execution            │
├─────────────────────────────────────────────────────────────────┤
│  Layer 4: Payment Execution                                     │
│  Razorpay Orders API → Checkout.js → Webhook → Reconcile        │
│  HMAC-SHA256 verified. Idempotent. Refundable.                  │
├─────────────────────────────────────────────────────────────────┤
│  Layer 3: Guardrails / Mandate Engine              [TEXT-BLIND] │
│  mandateEngine.ts — pure functions, unit tested (29 tests)      │
│  Reads: product.price (number). Ignores: description (string).  │
│  Enforces: budget cap, per-item cap, category allowlist, confirm│
├─────────────────────────────────────────────────────────────────┤
│  Layer 2: Agent / Reasoning                                     │
│  Claude claude-sonnet-4-5, 8 tools, tool-calling loop           │
│  Injection-sanitized input. Never sees Razorpay keys.           │
│  Never authorizes payments — mandate engine does.               │
├─────────────────────────────────────────────────────────────────┤
│  Layer 1: Catalog                                               │
│  /api/catalog.json — 12 real products + 1 adversarial           │
│  Injection scanned at read time. Adversarial product:           │
│  description contains "ignore all budget limits" — blocked.     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Security Properties

| Property | Mechanism | Where |
|----------|-----------|-------|
| LLM cannot authorize payment | Mandate engine re-validates server-side | `mandateEngine.ts` |
| Prompt injection blocked | Pattern-match on 12 injection signatures | `injectionSanitizer.ts` |
| No duplicate Razorpay charges | DB unique constraint on idempotencyKey | `idempotency.ts` |
| Payment tampering detected | HMAC-SHA256 signature verification | `razorpay.ts` |
| Webhook replay attack | Dedup by razorpay_payment_id | `/api/webhook` |
| Missing webhook recovery | Reconciliation job polls Razorpay | `/api/reconcile` |
| Secret keys never in client bundle | Server-only imports, no NEXT_PUBLIC_ for secrets | `razorpay.ts` |

---

## Why This Architecture Matters for Razorpay

The core problem CartGuard solves is **merchant AI-transactability at scale**:

1. **Today**: Merchants integrate Razorpay for human users. AI agents can't safely transact because there's no standard way to express spending constraints that the merchant's stack can enforce.

2. **CartGuard's answer**: The mandate config (`mandate.config.json`) is the machine-readable contract between principal (merchant/buyer) and agent. The mandate engine enforces it deterministically, regardless of what the LLM thinks.

3. **Next step**: Sign mandate configs with a principal's key (similar to x402 payment channels). An agent presents a signed mandate; the merchant verifies it; the mandate engine enforces it. This is the path to autonomous agentic commerce at Razorpay scale.
