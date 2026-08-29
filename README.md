# CartGuard — Bounded, Agent-to-Agent Checkout for Razorpay

> **Problem**: Every AI shopping system today uses the LLM as *both* the reasoning engine and the payment authorization engine. One injection → wrong charge.
>
> **CartGuard's answer**: A deterministic **mandate engine** — pure functions, zero LLM, unit-tested — sits between the agent and Razorpay. The LLM reasons. The mandate engine authorizes. They are never the same process.

> **🌐 Live Demo**: Add your URL here after deploying  
> **📹 Demo Video**: Record using [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)  
> **🏗️ Architecture**: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 3 sequence diagrams, 7-layer stack

---

## What Is This?

CartGuard makes a merchant **safely transactable by AI agents** — end to end. Built for the **Razorpay Hackathon — Track 01: AI Growth & Agentic Commerce**.

The single architectural insight that makes it different: **the mandate engine is text-blind**. It reads `product.price` (a number from the database). It never reads `product.description` (a string the LLM touches). A prompt injection in a product description physically cannot affect a spending decision.

---

---

## Quick Start

### Option A: Docker (Recommended — clone and run)

```bash
git clone https://github.com/YOUR_USERNAME/cartguard
cd cartguard
cp .env.example .env.local
# Edit .env.local with your Razorpay test keys + Anthropic key
docker compose up
```

Open: http://localhost:3000

### Option B: Manual

```bash
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev
```

---

## Architecture

```
[Chat UI /]  ──────────────────────►  ┌────────────────────────────┐
                                       │   Agent Orchestrator       │ ◄── Claude API (tool-calling)
[Buyer Agent CLI] ─────────────────►  │   POST /api/agent          │
                                       └──────────┬─────────────────┘
                                                  │ every tool call logged + validated
                                                  ▼
                                       ┌────────────────────────────┐
                                       │  Mandate Engine             │  deterministic, no LLM
                                       │  + Injection Sanitizer      │  pure functions, unit tested
                                       └──────────┬─────────────────┘
                                                  │
                           ┌──────────────────────┴─────────────────────┐
                           ▼                                             ▼
                 [Razorpay Test SDK]                          [Audit Log — SQLite]
                 Orders/Payments/Refund                       Every action, input, output
                           │                                             │
                           ▼                                             ▼
                 [Webhook Handler]  ─────────────────────►  [Reconciliation Job]
                 /api/webhook                                 /api/reconcile
```

---

## Key Differentiators

| Feature | How It's Different |
|---------|-------------------|
| 🛡️ **LLM never authorizes spend** | Deterministic mandate engine recomputes everything server-side from DB prices — never from LLM output |
| 🔁 **Idempotent checkout** | Every checkout request requires an `idempotencyKey`. Retries return the existing order — no duplicate Razorpay charges |
| ⚠️ **Adversarial catalog defense** | Seed includes a product with injection payload in description. Caught, logged, and ignored by the mandate engine |
| 🤖 **Autonomous buyer agent** | `npm run buyer-agent` — zero human clicks, real test-mode payment, full audit trail |
| 📋 **Live audit trail** | `/audit` — every tool call, mandate decision, and payment event with full input/output JSON |
| 📊 **Revenue metrics** | `/metrics` — upsell attach rate, AOV lift, conversion funnel from real session data |

---

## Demo Modes

### Human-in-the-Loop (`/`)
Chat with the AI agent. It searches the catalog, adds items to your cart, proposes upsells, and guides you through checkout. The mandate engine validates every step.

### Agent-to-Agent (`scripts/buyer-agent.ts`)
```bash
npm run buyer-agent -- --goal "running gear under 4000"

# Simulate failure → retry flow:
npm run buyer-agent -- --goal "running gear under 4000" --fail-first
```

This script:
1. Fetches the catalog **cold** — no shared session state
2. Reasons about what to buy with its own budget mandate
3. Calls the **exact same** `/api/checkout` endpoint the chat UI uses
4. Completes a real Razorpay test-mode payment
5. Logs everything to `/audit` tagged `actor: "autonomous_buyer_agent"`

---

## All 7 Layers Built

### 1. Catalog Layer
- `GET /api/catalog.json` — clean, documented, agent-readable JSON feed
- Adversarial product `prod_adversarial_trail` in seed with injection payload
- Injection detected at catalog-read time → logged with `decision: "blocked"`

### 2. Agent/Reasoning Layer
- Claude `claude-sonnet-4-5` with tool-calling
- 7 tools: `search_products`, `add_to_cart`, `remove_from_cart`, `propose_upsell`, `check_mandate`, `initiate_checkout`, `get_order_status`
- Every tool call logged BEFORE execution, result logged AFTER

### 3. Guardrail/Mandate Layer
- Budget cap: ₹4,000
- Per-item cap: ₹2,500
- Category allowlist: running_shoes, apparel, accessories, nutrition
- Human-confirm threshold: ₹3,000 (bypassed in agent mode)
- Idempotency: unique `idempotencyKey` constraint on Order table
- Unit tested: `tests/mandateEngine.test.ts`

### 4. Payment Layer
- Razorpay test-mode Order creation
- Checkout.js integration in chat UI
- Server-side signature verification on callback
- Webhook handler as source of truth — deduped by `razorpay_payment_id`
- Reconciliation job (`POST /api/reconcile`) for stuck orders
- Decline → explain → retry flow fully scripted
- Refund tool closing the full lifecycle

### 5. Audit/Trust Layer
- `/audit` — filterable by actor, expandable JSON rows
- Trust Summary panel: total actions, blocked, injection attempts, payment counts
- Real-time auto-refresh (3s polling)

### 6. Revenue-Impact Layer
- `/metrics` — upsell attach rate, AOV lift, conversion funnel, payment breakdown
- Agent vs human session split

### 7. Agent-to-Agent Layer
- `scripts/buyer-agent.ts` — full autonomous CLI
- Buyer-side mandate config (from `mandate.config.json`)
- Same backend APIs, different actor tag

---

## Environment Variables

```env
RAZORPAY_KEY_ID=rzp_test_...        # Razorpay test key ID
RAZORPAY_KEY_SECRET=...             # Razorpay test key secret
RAZORPAY_WEBHOOK_SECRET=...         # Webhook signing secret
ANTHROPIC_API_KEY=sk-ant-...        # Claude API key
DATABASE_URL=file:./dev.db          # SQLite (no external DB needed)
NEXT_PUBLIC_RAZORPAY_KEY_ID=rzp_test_...  # Public key for Checkout.js
NEXT_PUBLIC_APP_URL=http://localhost:3000
ENABLE_TEST_PAYMENT=true            # Enable buyer agent payment simulation
```

---

## Repo Structure

```
cartguard/
  README.md
  docker-compose.yml
  Dockerfile
  .env.example
  .github/workflows/ci.yml
  mandate.config.json             ← spend limits + category allowlist
  prisma/schema.prisma
  prisma/seed.ts                  ← 12 real products + 1 adversarial
  scripts/buyer-agent.ts          ← autonomous buyer agent CLI
  src/app/page.tsx                ← Chat UI
  src/app/audit/page.tsx          ← Audit trail dashboard
  src/app/metrics/page.tsx        ← Revenue metrics
  src/app/api/agent/route.ts      ← Claude orchestrator
  src/app/api/checkout/route.ts   ← Idempotent checkout
  src/app/api/webhook/route.ts    ← Razorpay webhooks
  src/app/api/reconcile/route.ts  ← Stuck order reconciliation
  src/app/api/refund/route.ts     ← Refund endpoint
  src/app/api/catalog.json/route.ts
  src/lib/mandateEngine.ts        ← Pure deterministic functions
  src/lib/injectionSanitizer.ts   ← Injection detection
  src/lib/idempotency.ts          ← Idempotent order creation
  src/lib/auditLog.ts             ← Audit trail
  src/lib/razorpay.ts             ← Razorpay SDK (server-only)
  tests/mandateEngine.test.ts     ← Unit tests
  tests/checkoutFlow.integration.test.ts
  docs/FAILURE.md                 ← Scripted failure demo
  docs/DEMO_SCRIPT.md             ← 5-min video script
  docs/SECURITY.md                ← Security architecture
```

---

## Security Highlights

- **LLM never holds Razorpay keys** — SDK is server-side only
- **Idempotent checkout** — safe to retry, no duplicate charges
- **Adversarial catalog** — injection in product description is caught + logged + ignored
- **Signature verification** — both client callback and webhook verified with HMAC-SHA256

See [docs/SECURITY.md](docs/SECURITY.md) for full details.

---

## Testing

```bash
# Unit tests (mandate engine — no API keys needed)
npm test

# Integration tests (requires Razorpay test keys)
npm run test:integration

# Both
npm run test:all
```

CI runs on every push — see [.github/workflows/ci.yml](.github/workflows/ci.yml).

---

## What's Next (Razorpay Product Roadmap Alignment)

- **Signed mandate configs**: Principal signs a `mandate.config.json` with their key. Agent presents it. Merchant verifies. Mandate engine enforces. No trust required from either side.
- **UAP/ACP protocol handshake**: Buyer agent and merchant agent negotiate capabilities and spend limits before any cart is built.
- **x402-style micropayments**: Razorpay payment channels between agents — no human sessions, no checkout UI.
- **Multi-merchant federation**: One buyer agent, many CartGuard merchants. The mandate config travels with the agent.

---

## Scripted Failure Summary

See [docs/FAILURE.md](docs/FAILURE.md) for the full flow. Short version:

| Attempt | Card | Result |
|---------|------|--------|
| 1 | `4000 0000 0000 0002` | ❌ Declined |
| 2 | `4111 1111 1111 1111` | ✅ Success |

Both attempts logged in `/audit`. Idempotency ensures no duplicate Razorpay orders.

---

*Built with Next.js 14 · Prisma · SQLite · Razorpay · Anthropic Claude · TypeScript*
