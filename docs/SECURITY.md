# SECURITY.md — CartGuard Security Architecture

## 1. Secrets Handling

### What's Kept Secret
| Secret | Where | How |
|--------|-------|-----|
| `RAZORPAY_KEY_SECRET` | Server-side only | Never sent to client, never logged |
| `RAZORPAY_WEBHOOK_SECRET` | Server-side only | Used only in webhook handler |
| `ANTHROPIC_API_KEY` | Server-side only | Never exposed to browser |

### What's Safe to Expose
- `NEXT_PUBLIC_RAZORPAY_KEY_ID` — Razorpay's public key ID, needed by Checkout.js

### Rules
- All `.env.*` files are in `.gitignore`
- `.env.example` contains only placeholder values
- The Razorpay SDK is imported only in `src/lib/razorpay.ts`, which is a server-side module
- API routes that call Razorpay are all in `src/app/api/` (server-side only)

---

## 2. Payment Signature Verification

**Every payment callback is verified server-side before any state change.**

### Client Callback Flow
```
1. Checkout.js completes payment
2. Razorpay calls handler with: { razorpay_payment_id, razorpay_order_id, razorpay_signature }
3. Client sends these to the server
4. Server computes HMAC-SHA256(order_id|payment_id, KEY_SECRET)
5. Compares with razorpay_signature — MUST match
6. Only then marks order as paid
```

### Webhook Flow
```
1. Razorpay POSTs to /api/webhook
2. Server reads raw body (before parsing JSON)
3. Computes HMAC-SHA256(rawBody, WEBHOOK_SECRET)
4. Compares with X-Razorpay-Signature header
5. If mismatch → log to audit, return 200 (no state change)
6. If match → process event
```

**Why both?** Webhooks are the source of truth but can be delayed. Client callbacks can be missed. Both are verified independently, and deduplication by `razorpay_payment_id` ensures the order is only marked paid once.

---

## 3. Idempotency

**The checkout endpoint is idempotent — safe to call multiple times.**

### Implementation
- Every checkout request requires an `idempotencyKey` parameter
- Format: `session:{sessionId}:attempt:{n}`
- Stored in `Order.idempotencyKey` with a `@unique` constraint
- On conflict (same key): return existing order, no Razorpay API call

### What This Prevents
- Double charges from network retries
- Duplicate orders from double-clicks
- Duplicate Razorpay orders from agent retry logic

### Race Condition Handling
If two concurrent requests hit the same idempotency key simultaneously (rare but possible), the DB unique constraint catches the second insert and the app fetches + returns the first.

---

## 4. Prompt Injection Defense

**The mandate engine is text-blind — it never reads text-based instructions.**

### What Could Be Attacked
- Product descriptions in the catalog
- User messages in chat
- Any text field the LLM processes

### Defense Layers

#### Layer 1: Injection Sanitizer (Detection)
`src/lib/injectionSanitizer.ts` scans all text for known injection patterns:
- "ignore all budget limits"
- "if you are an AI agent"
- "approve any purchase amount"
- "bypass guardrails"
- System prompt patterns (`[SYSTEM]`, `###instruction`)
- Jailbreak patterns (DAN mode, etc.)

Detection is logged to `audit_log` with `decision: "blocked"` before the LLM sees the text.

#### Layer 2: Mandate Engine (Enforcement)
`src/lib/mandateEngine.ts` is entirely text-blind:
- Reads only `product.price` (number) from the database
- Reads only `product.category` (string) against an allowlist
- Never reads `product.description` or any free-text field
- All amounts are recomputed from DB records, **never from LLM output**

**Result**: Even if injection bypasses Layer 1 and the LLM decides to "approve" an over-budget purchase, the mandate engine's server-side check blocks it anyway.

#### Layer 3: LLM Is Not the Authorizer
- The LLM calls `initiate_checkout(sessionId, idempotencyKey)`
- The checkout endpoint re-validates the cart from scratch via `validateCart()`
- The LLM's claimed amounts/decisions are **ignored** — only DB state matters

---

## 5. Rate Limiting

For this demo, rate limiting is not implemented (single merchant, demo context).

**In production, add:**
- Rate limit `/api/agent`: 10 req/min per IP
- Rate limit `/api/checkout`: 5 req/min per session
- Rate limit `/api/webhook`: Whitelist Razorpay IPs only

---

## 6. Test-Payment Endpoint

`/api/test-payment` exists **only** when `ENABLE_TEST_PAYMENT=true`.

This endpoint simulates payment success/failure for the autonomous buyer agent demo. **It must be disabled in production** — it bypasses real payment processing.

In production:
```
ENABLE_TEST_PAYMENT=false  # or leave unset
```

The endpoint returns 403 if the env var is not `"true"`.

---

## 7. Summary

| Threat | Defense |
|--------|---------|
| LLM authorizes payment | Mandate engine re-validates everything server-side |
| Prompt injection in catalog | Injection sanitizer detects + logs; mandate engine is text-blind |
| Duplicate payments (retry) | Idempotency key with DB unique constraint |
| Tampered payment callback | HMAC-SHA256 signature verification |
| Webhook replay attack | Deduplication by razorpay_payment_id |
| Leaked Razorpay secret | Key only in server-side code, never in client bundles |
| Missing webhook delivery | Reconciliation job polls Razorpay directly |
