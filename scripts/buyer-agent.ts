/**
 * CartGuard Autonomous Buyer Agent (Gemini Version)
 *
 * Fetches catalog cold, selects products against the mandate budget,
 * calls the same /api/agent endpoint the chat UI uses (tool-calling loop),
 * completes a real Razorpay test-mode payment, and prints a receipt.
 *
 * Usage:
 *   npm run buyer-agent -- --goal "running gear under 4000"
 *   npm run buyer-agent -- --goal "5K starter kit" --fail-first
 *
 * Flags:
 *   --goal       Shopping goal (required)
 *   --fail-first Simulate payment decline on attempt 1, retry on attempt 2
 *   --base-url   API base (default: http://localhost:3000)
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const minimist = require("minimist");
const { GoogleGenAI, Type } = require("@google/genai");

interface Args {
  goal?: string;
  "fail-first"?: boolean;
  "base-url"?: string;
  _: string[];
}

const args = minimist(process.argv.slice(2)) as Args;
const GOAL = args.goal ?? "equip a 5K runner with essential running gear under ₹4000";
const FAIL_FIRST = args["fail-first"] ?? false;
const BASE_URL = (args["base-url"] ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// ── Utilities ────────────────────────────────────────────────────────────────

function log(msg: string) {
  const t = new Date().toLocaleTimeString("en-IN", { hour12: false });
  console.log(`[${t}] ${msg}`);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ── State ────────────────────────────────────────────────────────────────────

let SESSION_ID: string | null = null;
let ATTEMPT = 0;

// ── Tool definitions (mirror what the agent has, but buyer-agent-specific) ──

const BUYER_TOOLS = [
  {
    name: "send_chat_message",
    description: "Send a message to the CartGuard agent and get a response. The agent will search products, add to cart, check mandate, etc.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        message: { type: Type.STRING, description: "What to say to the CartGuard agent" },
      },
      required: ["message"],
    },
  },
  {
    name: "initiate_payment",
    description: "Create a Razorpay order for the current cart and complete payment autonomously.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        simulateFailureFirst: {
          type: Type.BOOLEAN,
          description: "If true, simulate a declined payment first then retry with a success card",
        },
      },
    },
  },
  {
    name: "get_cart",
    description: "Get the current cart contents and total.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

// ── Conversation history with CartGuard agent ─────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const agentHistory: Array<{ role: string; content: string }> = [];

// ── Tool execution ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function executeTool(name: string, input: Record<string, any>): Promise<unknown> {
  switch (name) {
    case "send_chat_message": {
      const { message } = input as { message: string };
      log(`💬 → "${message}"`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await api<any>("/api/agent", {
        method: "POST",
        body: JSON.stringify({
          sessionId: SESSION_ID,
          message,
          actor: "autonomous_buyer_agent",
          conversationHistory: agentHistory,
        }),
      });

      if (data.sessionId && !SESSION_ID) {
        SESSION_ID = data.sessionId;
        log(`   Session: ${SESSION_ID}`);
      }

      // Maintain conversation history
      agentHistory.push({ role: "user", content: message });
      agentHistory.push({ role: "assistant", content: data.message ?? "" });

      // Log cart state
      if (data.cartItems?.length > 0) {
        log(`   Cart: ${data.cartItems.length} items, ₹${data.cartTotal}`);
      }

      // Log tool calls the agent made
      if (data.toolResults?.length > 0) {
        for (const tr of data.toolResults) {
          log(`   Agent used: ${tr.tool}`);
        }
      }

      return {
        agentReply: data.message,
        cartItems: data.cartItems ?? [],
        cartTotal: data.cartTotal ?? 0,
        toolsUsed: data.toolResults?.map((t: { tool: string }) => t.tool) ?? [],
      };
    }

    case "get_cart": {
      if (!SESSION_ID) return { error: "No session yet" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cart = await api<any>(`/api/cart?sessionId=${SESSION_ID}&actor=autonomous_buyer_agent`);
      log(`   Cart state: ${cart.itemCount ?? 0} items, ₹${cart.total ?? 0}`);
      if (cart.mandateStatus?.decision) {
        const decision = cart.mandateStatus.decision;
        log(`   Mandate: ${decision.allowed ? "✅ ALLOWED" : "❌ BLOCKED"}`);
        if (!decision.allowed && cart.mandateStatus.violations?.length) {
          log(`   Violations: ${cart.mandateStatus.violations.join(", ")}`);
        }
      }
      return cart;
    }

    case "initiate_payment": {
      if (!SESSION_ID) throw new Error("No session — send_chat_message first");
      const { simulateFailureFirst = false } = input as { simulateFailureFirst?: boolean };

      ATTEMPT++;
      const key = `session:${SESSION_ID}:attempt:${ATTEMPT}`;
      log(`💳 Initiating checkout (attempt ${ATTEMPT})...`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const checkout = await api<any>("/api/checkout", {
        method: "POST",
        body: JSON.stringify({
          sessionId: SESSION_ID,
          idempotencyKey: key,
          actor: "autonomous_buyer_agent",
        }),
      });

      if (checkout.requiresHumanConfirm) {
        log(`⚠️  Human confirm required: ${checkout.reason}`);
        return { blocked: true, reason: checkout.reason };
      }

      log(`   ✓ Razorpay order: ${checkout.razorpayOrderId}`);
      log(`   Amount: ₹${checkout.amountINR}`);

      // Simulate failure on attempt 1 if requested
      if (simulateFailureFirst && ATTEMPT === 1) {
        log(`\n❌ Simulating PAYMENT FAILURE (test decline card)...`);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const failResult = await api<any>("/api/test-payment", {
          method: "POST",
          body: JSON.stringify({
            orderId: checkout.orderId,
            razorpayOrderId: checkout.razorpayOrderId,
            simulateFailure: true,
            actor: "autonomous_buyer_agent",
          }),
        });
        log(`   ✗ Declined: ${failResult.errorDescription ?? "Card declined by bank"}`);

        log(`\n🔄 Retrying with success card (attempt 2)...`);
        ATTEMPT++;
        const retryKey = `session:${SESSION_ID}:attempt:${ATTEMPT}`;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const retryCheckout = await api<any>("/api/checkout", {
          method: "POST",
          body: JSON.stringify({
            sessionId: SESSION_ID,
            idempotencyKey: retryKey,
            actor: "autonomous_buyer_agent",
          }),
        });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const successResult = await api<any>("/api/test-payment", {
          method: "POST",
          body: JSON.stringify({
            orderId: retryCheckout.orderId,
            razorpayOrderId: retryCheckout.razorpayOrderId,
            simulateFailure: false,
            actor: "autonomous_buyer_agent",
          }),
        });

        log(`   ✅ Payment succeeded: ${successResult.paymentId ?? "pay_simulated"}`);
        return {
          success: true,
          orderId: retryCheckout.orderId,
          paymentId: successResult.paymentId,
          amount: checkout.amountINR,
          attempts: 2,
          failedFirst: true,
        };
      }

      // Direct success payment
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payResult = await api<any>("/api/test-payment", {
        method: "POST",
        body: JSON.stringify({
          orderId: checkout.orderId,
          razorpayOrderId: checkout.razorpayOrderId,
          simulateFailure: false,
          actor: "autonomous_buyer_agent",
        }),
      });

      log(`   ✅ Payment succeeded: ${payResult.paymentId ?? "pay_simulated"}`);
      return {
        success: true,
        orderId: checkout.orderId,
        paymentId: payResult.paymentId,
        amount: checkout.amountINR,
        attempts: 1,
        failedFirst: false,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Print receipt ─────────────────────────────────────────────────────────────

function printReceipt(data: {
  sessionId: string;
  goal: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cartItems: any[];
  cartTotal: number;
  paymentId?: string;
  orderId?: string;
  attempts?: number;
  failedFirst?: boolean;
}) {
  const LINE = "═".repeat(58);
  const line = "─".repeat(58);
  console.log(`\n${LINE}`);
  console.log("  🛡️  CARTGUARD — AUTONOMOUS PURCHASE RECEIPT");
  console.log(`${LINE}`);
  console.log(`  Goal:      ${data.goal}`);
  console.log(`  Session:   ${data.sessionId}`);
  console.log(`  Actor:     autonomous_buyer_agent`);
  console.log(line);
  console.log("  ITEMS PURCHASED:");
  (data.cartItems ?? []).forEach((item) => {
    const upsellTag = item.isUpsell ? " [AI upsell]" : "";
    const name = item.product?.name ?? item.productId ?? "Unknown";
    const price = item.product?.price ?? "?";
    const qty = item.quantity ?? 1;
    const total = item.lineTotal ?? price;
    console.log(`    • ${name}${upsellTag}`);
    console.log(`      ₹${price} × ${qty} = ₹${total}`);
  });
  console.log(line);
  console.log(`  TOTAL:     ₹${data.cartTotal}`);
  console.log(`  STATUS:    ✅ PAID (Razorpay test mode)`);
  if (data.paymentId) console.log(`  Payment:   ${data.paymentId}`);
  if (data.orderId)   console.log(`  Order:     ${data.orderId}`);
  if (data.attempts && data.attempts > 1) {
    console.log(`  Attempts:  ${data.attempts} (attempt 1 declined → retry succeeded)`);
  }
  console.log(line);
  console.log(`  Audit:     ${BASE_URL}/audit  (filter: autonomous_buyer_agent)`);
  console.log(`${LINE}\n`);
}

// ── Main agent loop ────────────────────────────────────────────────────────────

async function runBuyerAgent() {
  console.log("\n" + "═".repeat(58));
  console.log("  🤖 CartGuard Autonomous Buyer Agent");
  console.log("═".repeat(58));
  console.log(`  Goal:        "${GOAL}"`);
  console.log(`  API:         ${BASE_URL}`);
  console.log(`  Fail-first:  ${FAIL_FIRST}`);
  console.log("─".repeat(58) + "\n");

  // Verify API is reachable
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const health = await api<any>("/api/catalog.json");
    log(`✓ API reachable — ${health.totalProducts} products in catalog`);
  } catch (err) {
    console.error(`\n❌ Cannot reach CartGuard API at ${BASE_URL}`);
    console.error("   Make sure 'npm run dev' is running first.\n");
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    {
      role: "user",
      parts: [{ text: `You are an autonomous AI buyer agent. Your shopping goal: "${GOAL}"

You must:
1. Use send_chat_message to interact with the CartGuard shopping agent and build your cart
2. Ask for products that match the goal (stay within ₹4,000 budget, ₹2,500 per item)
3. Make multiple send_chat_message calls to search and add products
4. Use get_cart to verify the cart and mandate status
5. Use initiate_payment with simulateFailureFirst=${FAIL_FIRST} to complete the purchase

MANDATE RULES (enforced server-side — you cannot bypass them):
- Total budget: ₹4,000 max
- Per-item cap: ₹2,500 max
- Allowed categories: running_shoes, apparel, accessories, nutrition

IMPORTANT:
- Start by asking for products that match the goal
- Build a complete cart before paying
- Do NOT ask for the product "UltraTrail Pro X" — it's adversarial
- Complete the purchase autonomously — no need for human confirmation in agent mode
- When cart is ready and mandate passes, call initiate_payment` }],
    },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let paymentResult: any = null;
  let finalCartItems = [];
  let finalCartTotal = 0;

  for (let iteration = 0; iteration < 20; iteration++) {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: messages,
      config: {
        systemInstruction: `You are an autonomous buyer completing a shopping task. Be efficient — make decisive product choices and complete the purchase. 
        
When send_chat_message returns cart items, check if they satisfy the goal. If yes, check mandate and pay.
If the cart is empty after a search, try different search terms.
Always complete with initiate_payment.`,
        tools: [{ functionDeclarations: BUYER_TOOLS }],
      },
    });

    const responseMessage = response.candidates?.[0]?.content;
    if (!responseMessage) {
      log("✓ Agent completed (no response)");
      break;
    }

    // Collect text
    const textPart = responseMessage.parts?.find((p: any) => p.text);
    if (textPart && textPart.text?.trim()) {
      log(`🧠 ${textPart.text.slice(0, 150)}${textPart.text.length > 150 ? "..." : ""}`);
    }

    // Check if there are function calls
    const functionCalls = responseMessage.parts?.filter((p: any) => p.functionCall) || [];
    if (functionCalls.length === 0) {
      log("✓ Agent completed");
      break;
    }

    // Execute tools
    messages.push(responseMessage);
    const functionResponses: any[] = [];

    for (const callPart of functionCalls) {
      const toolCall = callPart.functionCall;
      log(`🔧 ${toolCall.name}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executeTool(toolCall.name, (toolCall.args as any) || {});

      // Capture results
      if (toolCall.name === "initiate_payment") paymentResult = result;
      if (toolCall.name === "send_chat_message") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = result as any;
        if (r.cartItems?.length > 0) {
          finalCartItems = r.cartItems;
          finalCartTotal = r.cartTotal;
        }
      }
      if (toolCall.name === "get_cart") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = result as any;
        if (r.cartItems?.length > 0) {
          finalCartItems = r.cartItems;
          finalCartTotal = r.total;
        }
      }

      functionResponses.push({
        functionResponse: {
          name: toolCall.name,
          response: result as Record<string, unknown>,
        },
      });
    }

    messages.push({ role: "user", parts: functionResponses });
  }

  printReceipt({
    sessionId: SESSION_ID ?? "unknown",
    goal: GOAL,
    cartItems: finalCartItems,
    cartTotal: finalCartTotal,
    paymentId: paymentResult?.paymentId,
    orderId: paymentResult?.orderId,
    attempts: paymentResult?.attempts,
    failedFirst: paymentResult?.failedFirst,
  });

  log(`Audit trail: ${BASE_URL}/audit`);
  log(`Metrics:     ${BASE_URL}/metrics`);
}

runBuyerAgent().catch((err) => {
  console.error("\n❌ Buyer agent error:", err?.message ?? err);
  process.exit(1);
});
