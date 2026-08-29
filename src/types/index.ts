// Shared TypeScript types for CartGuard

export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  imageUrl?: string | null;
  inStock: boolean;
  isAdversarial: boolean;
  createdAt: Date;
}

export interface Session {
  id: string;
  actor: "human_chat" | "autonomous_buyer_agent";
  goal?: string | null;
  status: "active" | "completed" | "abandoned";
  createdAt: Date;
  updatedAt: Date;
}

export interface CartItem {
  id: string;
  sessionId: string;
  productId: string;
  quantity: number;
  isUpsell: boolean;
  addedAt: Date;
  product?: Product;
}

export interface Order {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  razorpayOrderId?: string | null;
  razorpayPaymentId?: string | null;
  amount: number;
  currency: string;
  status: "created" | "attempted" | "paid" | "failed" | "refunded";
  refundId?: string | null;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  sessionId?: string | null;
  actor: string;
  tool: string;
  inputJson: string;
  outputJson?: string | null;
  decision?: string | null;
  reason?: string | null;
  createdAt: Date;
}

// Mandate engine types
export interface MandateConfig {
  budgetCapINR: number;
  perItemCapINR: number;
  categoryAllowlist: string[];
  humanConfirmThresholdINR: number;
  maxCartItems: number;
  maxQuantityPerItem: number;
  currency: string;
  buyerAgentOverrides?: {
    budgetCapINR: number;
    humanConfirmThresholdINR: number;
    note: string;
  };
}

export type MandateDecision =
  | { allowed: true; requiresHumanConfirm: false }
  | { allowed: true; requiresHumanConfirm: true; reason: string }
  | { allowed: false; requiresHumanConfirm: false; reason: string };

export interface CartValidation {
  totalAmount: number;
  itemCount: number;
  decision: MandateDecision;
  violations: string[];
}

// Agent tool types
export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentRequest {
  sessionId?: string;
  message: string;
  actor?: "human_chat" | "autonomous_buyer_agent";
}

export interface AgentResponse {
  sessionId: string;
  message: string;
  cartItems?: CartItem[];
  mandateStatus?: CartValidation;
  orderCreated?: Order;
}

// Injection sanitizer types
export interface InjectionCheckResult {
  clean: boolean;
  patterns: string[];
  sanitizedText: string;
}

// Checkout types
export interface CheckoutRequest {
  sessionId: string;
  idempotencyKey: string;
  actor?: string;
}

export interface CheckoutResponse {
  orderId: string;
  razorpayOrderId: string;
  amount: number;
  currency: string;
  keyId: string;
  isExisting?: boolean;
}
