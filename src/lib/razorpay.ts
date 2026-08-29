/**
 * Razorpay SDK Wrapper — server-side only.
 *
 * SECURITY RULES:
 * 1. The LLM never holds or accesses Razorpay keys.
 * 2. The LLM never calls these functions directly.
 * 3. All Razorpay calls are made AFTER mandate engine validation.
 * 4. Signature verification is always performed server-side.
 *
 * Never import this file in client-side components.
 */

import Razorpay from "razorpay";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Client initialization
// ---------------------------------------------------------------------------

function getRazorpayClient(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in environment"
    );
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

// ---------------------------------------------------------------------------
// Order operations
// ---------------------------------------------------------------------------

export interface CreateOrderParams {
  amountINR: number;
  currency?: string;
  receipt?: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrderResult {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

/**
 * Create a Razorpay order in test mode.
 * Amount is in paise (INR * 100).
 */
export async function createRazorpayOrder(
  params: CreateOrderParams
): Promise<RazorpayOrderResult> {
  const razorpay = getRazorpayClient();
  const amountPaise = Math.round(params.amountINR * 100);

  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: params.currency ?? "INR",
    receipt: params.receipt ?? `receipt_${Date.now()}`,
    notes: params.notes ?? {},
  });

  return {
    id: order.id,
    amount: Number(order.amount),
    currency: order.currency,
    receipt: order.receipt ?? "",
    status: order.status,
  };
}

/**
 * Fetch an order's current status from Razorpay (used by reconciliation).
 */
export async function fetchRazorpayOrder(orderId: string): Promise<{
  id: string;
  status: string;
  amount_paid: number;
  attempts: number;
}> {
  const razorpay = getRazorpayClient();
  const order = await razorpay.orders.fetch(orderId);
  return {
    id: order.id,
    status: order.status,
    amount_paid: Number(order.amount_paid),
    attempts: Number(order.attempts),
  };
}

/**
 * Fetch all payments for a Razorpay order.
 */
export async function fetchPaymentsForOrder(orderId: string) {
  const razorpay = getRazorpayClient();
  const payments = await razorpay.orders.fetchPayments(orderId);
  return payments;
}

// ---------------------------------------------------------------------------
// Signature verification (server-side — never on client)
// ---------------------------------------------------------------------------

/**
 * Verify the Razorpay payment signature from the checkout callback.
 * Called server-side after the client sends back razorpay_payment_id,
 * razorpay_order_id, and razorpay_signature.
 */
export function verifyPaymentSignature(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): boolean {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) throw new Error("RAZORPAY_KEY_SECRET not set");

  const body = `${params.razorpayOrderId}|${params.razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(body)
    .digest("hex");

  return expectedSignature === params.razorpaySignature;
}

/**
 * Verify a Razorpay webhook signature.
 */
export function verifyWebhookSignature(
  rawBody: string,
  razorpaySignature: string
): boolean {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error("RAZORPAY_WEBHOOK_SECRET not set");

  const expectedSignature = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  return expectedSignature === razorpaySignature;
}

// ---------------------------------------------------------------------------
// Refund operations
// ---------------------------------------------------------------------------

export interface RefundResult {
  id: string;
  paymentId: string;
  amount: number;
  status: string;
}

/**
 * Initiate a full refund for a payment.
 */
export async function createRefund(
  paymentId: string,
  amountPaise?: number
): Promise<RefundResult> {
  const razorpay = getRazorpayClient();

  const refundParams: { amount?: number } = {};
  if (amountPaise) refundParams.amount = amountPaise;

  const refund = await razorpay.payments.refund(paymentId, refundParams);

  return {
    id: refund.id,
    paymentId: refund.payment_id,
    amount: Number(refund.amount),
    status: refund.status,
  };
}
