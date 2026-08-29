# FAILURE.md — Scripted Failure Demo

This document describes the exact payment failure scenario that should be demonstrated in the 5-minute demo video.

## The Flow

### Step 1: Build a Valid Cart

Using the chat UI, build a cart under ₹4,000:
- Trail Running Shoes Pro — ₹2,999
- Anti-Blister Running Socks (3-pack) — ₹349
- **Total: ₹3,348**

### Step 2: Trigger Checkout — Decline Card

1. Click **"Checkout with Razorpay →"** in the cart sidebar
2. In the Razorpay payment modal:
   - Card number: **`4000 0000 0000 0002`** (Razorpay test decline card)
   - Expiry: Any future date (e.g., `12/26`)
   - CVV: Any 3 digits (e.g., `123`)
   - Name: Any name
3. Click Pay

**Expected result**: Payment fails. Razorpay returns a decline error.

The agent responds:
> ❌ **Payment Declined**
>
> Your card was declined. If you're testing, try card **4111 1111 1111 1111** with any future expiry and CVV 123.
>
> Should I retry checkout with a different card?

### Step 3: Flip to /audit

Go to `/audit` immediately. You'll see:
- `payment_failed` event from `webhook` actor
- Both the checkout creation and the failure logged with full input/output JSON
- Decision: `blocked`
- Reason: `Payment failed: Your payment has been declined by your bank`

### Step 4: Retry with Success Card

1. User asks: "Yes, retry with the success card"
2. Agent initiates checkout again with **a new idempotency key** (attempt:2)
3. In the Razorpay modal:
   - Card number: **`4111 1111 1111 1111`** (Razorpay test success card)
   - Expiry: `12/26`
   - CVV: `123`
4. Click Pay

**Expected result**: Payment succeeds ✅

The agent responds:
> ✅ **Payment Successful!**
>
> Payment ID: `pay_XXXXXXXX`
> Order ID: `order_XXXXXXXX`
>
> Your running gear is on its way! 🎉

### Step 5: Idempotency — Safe Retry

Note that the retry uses a **new idempotency key** (`session:{id}:attempt:2`).
The failed attempt's order is NOT reused — a new Razorpay order is created.
This is correct behavior: a failed order should not be retried; a new order is created.

However, if the user accidentally double-clicks "Checkout" during the success attempt, the idempotency layer prevents a duplicate Razorpay order from being created.

### Step 6: Refund

After successful payment, click **"↩️ Refund this order"** in the cart sidebar.

The refund is initiated via Razorpay, the order status transitions to `refunded`, and the agent confirms:
> ↩️ **Refund initiated!**
>
> Refund ID: `rfnd_XXXXXXXX`
> Full lifecycle: created → paid → refunded ✓

---

## Razorpay Test Cards Reference

| Card Number | Result |
|-------------|--------|
| `4111 1111 1111 1111` | ✅ Payment success |
| `4000 0000 0000 0002` | ❌ Card declined |
| `5267 3181 8797 5449` | ✅ Mastercard success |
| `4000 0000 0000 0101` | ❌ Insufficient funds |

All cards: Expiry = any future date, CVV = any 3 digits, Name = any.

---

## Buyer Agent Failure Demo

Run in terminal:
```bash
npm run buyer-agent -- --goal "running gear under 4000" --fail-first
```

This will:
1. Create a cart autonomously
2. Attempt payment with the decline card
3. Log the failure to `/audit`
4. **Automatically retry** with the success card
5. Complete the purchase
6. Print a terminal receipt showing `attempts: 2`
