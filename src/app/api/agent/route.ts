/**
 * POST /api/agent — Main Agent Orchestrator
 *
 * Runs a Claude tool-calling loop for one conversation turn.
 * The agent can call tools to search products, manage the cart,
 * check mandate status, and initiate checkout.
 *
 * SECURITY BOUNDARIES:
 * - Injection sanitizer scans user message before Claude sees it
 * - Every tool call is logged to audit_log BEFORE execution
 * - Every tool result is logged AFTER execution
 * - Mandate engine validates EVERY cart mutation server-side
 * - LLM never sees or holds Razorpay keys
 * - LLM output is NEVER treated as authorization for money actions
 */

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { logAction } from "@/lib/auditLog";
import { scanUserMessage, scanProductForInjection } from "@/lib/injectionSanitizer";
import { validateCart, validateUpsellItem } from "@/lib/mandateEngine";
import type { CartItemWithProduct } from "@/lib/mandateEngine";
import mandateConfig from "../../../../mandate.config.json";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Tool definitions for Claude
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "search_products",
    description:
      "Search the product catalog by query, category, or max price. Returns matching products with prices in INR.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search term (product name or keyword)" },
        category: {
          type: "string",
          enum: ["running_shoes", "apparel", "accessories", "nutrition"],
          description: "Filter by product category",
        },
        maxPrice: { type: "number", description: "Maximum price in INR" },
      },
    },
  },
  {
    name: "add_to_cart",
    description:
      "Add a product to the shopping cart. The mandate engine will validate this action.",
    input_schema: {
      type: "object" as const,
      required: ["productId", "sessionId"],
      properties: {
        productId: { type: "string", description: "Product ID from the catalog" },
        sessionId: { type: "string" },
        quantity: { type: "number", default: 1 },
        isUpsell: {
          type: "boolean",
          description: "Set to true if this is an agent-suggested upsell item",
          default: false,
        },
      },
    },
  },
  {
    name: "remove_from_cart",
    description: "Remove an item from the shopping cart.",
    input_schema: {
      type: "object" as const,
      required: ["cartItemId", "sessionId"],
      properties: {
        cartItemId: { type: "string" },
        sessionId: { type: "string" },
      },
    },
  },
  {
    name: "propose_upsell",
    description:
      "Suggest a complementary product to add to the cart. The mandate engine will validate whether the upsell fits within budget.",
    input_schema: {
      type: "object" as const,
      required: ["productId", "sessionId", "reason"],
      properties: {
        productId: { type: "string", description: "Product to suggest" },
        sessionId: { type: "string" },
        reason: { type: "string", description: "Why this product complements the cart" },
      },
    },
  },
  {
    name: "check_mandate",
    description:
      "Check if the current cart passes all mandate constraints (budget, per-item cap, categories). Returns whether checkout is allowed.",
    input_schema: {
      type: "object" as const,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        isAgentMode: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "initiate_checkout",
    description:
      "Create a Razorpay order for the current cart. Returns the order details needed for payment. Requires mandate to pass first.",
    input_schema: {
      type: "object" as const,
      required: ["sessionId", "idempotencyKey"],
      properties: {
        sessionId: { type: "string" },
        idempotencyKey: {
          type: "string",
          description:
            "Unique key for idempotent checkout. Format: session:{id}:attempt:{n}",
        },
      },
    },
  },
  {
    name: "get_order_status",
    description: "Get the current status of an order.",
    input_schema: {
      type: "object" as const,
      required: ["orderId"],
      properties: {
        orderId: { type: "string" },
      },
    },
  },
  {
    name: "get_cart",
    description: "Get the current cart contents and total.",
    input_schema: {
      type: "object" as const,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

async function executeTool(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId: string,
  actor: string
): Promise<unknown> {
  switch (toolName) {
    case "search_products": {
      const { query, category, maxPrice } = toolInput as {
        query?: string;
        category?: string;
        maxPrice?: number;
      };

      const where: Record<string, unknown> = { inStock: true };
      if (category) where.category = category;
      if (maxPrice) where.price = { lte: maxPrice };
      if (query) {
        where.OR = [
          { name: { contains: query } },
          { description: { contains: query } },
        ];
      }

      const products = await prisma.product.findMany({
        where,
        orderBy: { price: "asc" },
        take: 10,
      });

      // Scan results for injection (adversarial demo)
      const scannedProducts = products.map((p) => {
        const scan = scanProductForInjection(p as Record<string, unknown>);
        if (!scan.clean) {
          // Already logged in catalog endpoint, but log again for traceability
          logAction({
            sessionId,
            actor: "mandate_engine",
            tool: "injection_detected",
            input: { productId: p.id, field: scan.field, patterns: scan.patterns },
            output: { action: "description_sanitized" },
            decision: "blocked",
            reason: `Injection in product "${p.name}" field "${scan.field}" — ignored by mandate engine`,
          });
          return { ...p, description: scan.sanitizedText };
        }
        return p;
      });

      return {
        found: scannedProducts.length,
        products: scannedProducts.map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          price: p.price,
          priceFormatted: `₹${p.price}`,
          category: p.category,
          inStock: p.inStock,
        })),
      };
    }

    case "add_to_cart": {
      const { productId, quantity = 1, isUpsell = false } = toolInput as {
        productId: string;
        quantity?: number;
        isUpsell?: boolean;
      };

      const product = await prisma.product.findUnique({
        where: { id: productId },
      });
      if (!product) return { error: `Product ${productId} not found` };
      if (!product.inStock) return { error: `${product.name} is out of stock` };

      // Get current cart total for upsell validation
      const currentCart = await prisma.cartItem.findMany({
        where: { sessionId },
        include: { product: true },
      });
      const currentTotal = currentCart.reduce(
        (s, i) => s + i.product.price * i.quantity,
        0
      );

      // Mandate check BEFORE adding
      const isAgentMode = actor === "autonomous_buyer_agent";
      const upsellCheck = validateUpsellItem(
        product as import("@/types").Product,
        currentTotal,
        mandateConfig,
        isAgentMode
      );

      if (!upsellCheck.allowed) {
        return {
          blocked: true,
          reason: upsellCheck.reason,
          mandateDecision: "blocked",
        };
      }

      // Upsert cart item
      const existing = await prisma.cartItem.findFirst({
        where: { sessionId, productId },
      });

      let cartItem;
      if (existing) {
        cartItem = await prisma.cartItem.update({
          where: { id: existing.id },
          data: { quantity: existing.quantity + (quantity as number) },
          include: { product: true },
        });
      } else {
        cartItem = await prisma.cartItem.create({
          data: {
            sessionId,
            productId,
            quantity: quantity as number,
            isUpsell: isUpsell as boolean,
          },
          include: { product: true },
        });
      }

      return {
        added: true,
        cartItem: {
          id: cartItem.id,
          product: { id: product.id, name: product.name, price: product.price },
          quantity: cartItem.quantity,
          isUpsell: cartItem.isUpsell,
          lineTotal: product.price * cartItem.quantity,
        },
      };
    }

    case "remove_from_cart": {
      const { cartItemId } = toolInput as { cartItemId: string };
      await prisma.cartItem.delete({ where: { id: cartItemId } });
      return { removed: true, cartItemId };
    }

    case "propose_upsell": {
      const { productId, reason } = toolInput as {
        productId: string;
        reason: string;
      };

      const product = await prisma.product.findUnique({
        where: { id: productId },
      });
      if (!product) return { error: "Product not found" };

      const currentCart = await prisma.cartItem.findMany({
        where: { sessionId },
        include: { product: true },
      });
      const currentTotal = currentCart.reduce(
        (s, i) => s + i.product.price * i.quantity,
        0
      );

      const isAgentMode = actor === "autonomous_buyer_agent";
      const check = validateUpsellItem(
        product as import("@/types").Product,
        currentTotal,
        mandateConfig,
        isAgentMode
      );

      return {
        product: {
          id: product.id,
          name: product.name,
          price: product.price,
          priceFormatted: `₹${product.price}`,
          category: product.category,
        },
        agentReason: reason,
        mandateApproved: check.allowed,
        mandateReason: check.allowed
          ? "Upsell fits within budget and mandate constraints"
          : check.reason,
      };
    }

    case "check_mandate": {
      const { isAgentMode = false } = toolInput as { isAgentMode?: boolean };

      const cartItems = await prisma.cartItem.findMany({
        where: { sessionId },
        include: { product: true },
      });

      const validation = validateCart(
        cartItems as CartItemWithProduct[],
        mandateConfig,
        isAgentMode || actor === "autonomous_buyer_agent"
      );

      return {
        totalAmount: validation.totalAmount,
        totalFormatted: `₹${validation.totalAmount}`,
        itemCount: validation.itemCount,
        decision: validation.decision,
        violations: validation.violations,
        allowed: validation.decision.allowed,
        requiresHumanConfirm:
          "requiresHumanConfirm" in validation.decision
            ? validation.decision.requiresHumanConfirm
            : false,
      };
    }

    case "initiate_checkout": {
      const { idempotencyKey } = toolInput as { idempotencyKey: string };

      // Call checkout endpoint server-to-server
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
      const response = await fetch(`${baseUrl}/api/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, idempotencyKey, actor }),
      });

      const data = await response.json();
      if (!response.ok) {
        return { error: data.error ?? "Checkout failed", details: data };
      }

      return data;
    }

    case "get_order_status": {
      const { orderId } = toolInput as { orderId: string };
      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return { error: "Order not found" };

      return {
        orderId: order.id,
        status: order.status,
        amount: order.amount,
        razorpayOrderId: order.razorpayOrderId,
        razorpayPaymentId: order.razorpayPaymentId,
        createdAt: order.createdAt,
      };
    }

    case "get_cart": {
      const cartItems = await prisma.cartItem.findMany({
        where: { sessionId },
        include: { product: true },
        orderBy: { addedAt: "asc" },
      });

      const total = cartItems.reduce(
        (s, i) => s + i.product.price * i.quantity,
        0
      );

      return {
        cartItems: cartItems.map((i) => ({
          id: i.id,
          product: { id: i.product.id, name: i.product.name, price: i.product.price },
          quantity: i.quantity,
          isUpsell: i.isUpsell,
          lineTotal: i.product.price * i.quantity,
        })),
        total,
        totalFormatted: `₹${total}`,
        itemCount: cartItems.length,
      };
    }

    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ---------------------------------------------------------------------------
// Agent orchestrator
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      sessionId: incomingSessionId,
      message,
      actor = "human_chat",
      conversationHistory = [],
    } = body as {
      sessionId?: string;
      message: string;
      actor?: string;
      conversationHistory?: Array<{ role: string; content: string }>;
    };

    if (!message) {
      return NextResponse.json({ error: "message required" }, { status: 400 });
    }

    // ── Get or create session ──────────────────────────────────────────────
    let sessionId = incomingSessionId;
    if (!sessionId) {
      const session = await prisma.session.create({
        data: { actor: actor as string, status: "active" },
      });
      sessionId = session.id;
    }

    // ── Injection check on user message ───────────────────────────────────
    const injectionCheck = scanUserMessage(message);
    if (!injectionCheck.clean) {
      await logAction({
        sessionId,
        actor: "mandate_engine",
        tool: "injection_detected",
        input: { message: message.slice(0, 200), patterns: injectionCheck.patterns },
        output: { action: "message_sanitized", note: "Mandate engine ignores text instructions regardless" },
        decision: "blocked",
        reason: `Possible injection in user message. Patterns: ${injectionCheck.patterns.join(", ")}. Proceeding with sanitized message — mandate engine is text-blind.`,
      });
    }

    // Use sanitized message for LLM (injection attempt noted but not honored)
    const safeMessage = injectionCheck.sanitizedText;

    // ── Build messages ─────────────────────────────────────────────────────
    const messages: Anthropic.MessageParam[] = [
      ...conversationHistory.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user", content: safeMessage },
    ];

    // ── Tool-calling loop ──────────────────────────────────────────────────
    const toolResults: Array<{ tool: string; input: unknown; output: unknown }> = [];
    let finalText = "";
    let loopMessages = [...messages];

    for (let iteration = 0; iteration < 10; iteration++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 4096,
        system: `You are CartGuard, an AI shopping assistant for a running gear store.

IMPORTANT RULES:
1. You help users discover and purchase running gear within their budget.
2. The MANDATE ENGINE enforces all spending limits deterministically — you do NOT authorize payments.
3. Always use check_mandate before suggesting checkout.
4. When suggesting upsells, use propose_upsell to check mandate compatibility first.
5. If mandate blocks an action, explain clearly and suggest alternatives within budget.
6. For checkout, generate an idempotency key in format: session:{sessionId}:attempt:{n}
7. Current session ID: ${sessionId}
8. Actor type: ${actor}
9. For autonomous agent mode: complete the purchase autonomously without requiring human confirmation (the mandate engine handles all guardrails).

Available budget: ₹4,000 max. Per-item cap: ₹2,500. Human confirm required above ₹3,000 (human mode only).

Always be helpful, suggest relevant gear, and explain mandate decisions clearly to the user.`,
        tools: TOOLS,
        messages: loopMessages,
      });

      // Collect text
      for (const block of response.content) {
        if (block.type === "text") {
          finalText = block.text;
        }
      }

      // Handle tool calls
      if (response.stop_reason === "tool_use") {
        const toolUseBlocks = response.content.filter(
          (b) => b.type === "tool_use"
        ) as Anthropic.ToolUseBlock[];

        // Add assistant message to loop
        loopMessages.push({ role: "assistant", content: response.content });

        const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          const toolInput = toolUse.input as Record<string, unknown>;

          // Log BEFORE execution
          await logAction({
            sessionId,
            actor,
            tool: toolUse.name,
            input: toolInput,
            decision: undefined,
            reason: "Tool call initiated by agent",
          });

          // Execute tool
          const result = await executeTool(
            toolUse.name,
            toolInput,
            sessionId,
            actor
          );

          // Determine decision for logging
          const resultObj = result as Record<string, unknown>;
          const decision =
            resultObj.blocked === true
              ? "blocked"
              : resultObj.error
                ? "blocked"
                : resultObj.requiresHumanConfirm
                  ? "requires_human_confirm"
                  : "allowed";

          // Log AFTER execution
          await logAction({
            sessionId,
            actor,
            tool: `${toolUse.name}_result`,
            input: toolInput,
            output: result,
            decision: decision as "allowed" | "blocked" | "requires_human_confirm",
            reason:
              resultObj.reason as string ??
              (decision === "blocked"
                ? "Tool execution blocked by mandate engine"
                : "Tool executed successfully"),
          });

          toolResults.push({
            tool: toolUse.name,
            input: toolInput,
            output: result,
          });

          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }

        loopMessages.push({ role: "user", content: toolResultBlocks });
      } else {
        // No more tool calls — done
        break;
      }
    }

    // Get current cart for response
    const cartItems = await prisma.cartItem.findMany({
      where: { sessionId },
      include: { product: true },
    });

    return NextResponse.json({
      sessionId,
      message: finalText,
      toolResults,
      cartItems: cartItems.map((i) => ({
        id: i.id,
        product: i.product,
        quantity: i.quantity,
        isUpsell: i.isUpsell,
        lineTotal: i.product.price * i.quantity,
      })),
      cartTotal: cartItems.reduce(
        (s, i) => s + i.product.price * i.quantity,
        0
      ),
    });
  } catch (error) {
    console.error("[/api/agent]", error);
    return NextResponse.json(
      {
        error: "Agent error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
