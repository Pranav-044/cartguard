/**
 * GET /api/catalog.json
 *
 * Agent-readable product catalog endpoint.
 * Scans all products for injection attempts at read-time,
 * logs any detected injections to audit_log, and returns
 * the full catalog in a clean, structured JSON format.
 *
 * The injection detection happens HERE — before the LLM ever sees
 * the product descriptions. However, the mandate engine still ignores
 * all text-based instructions regardless.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { scanProductForInjection } from "@/lib/injectionSanitizer";
import { logAction } from "@/lib/auditLog";

export async function GET() {
  try {
    const products = await prisma.product.findMany({
      orderBy: { category: "asc" },
    });

    // Scan each product for injection attempts
    for (const product of products) {
      const scanResult = scanProductForInjection(
        product as Record<string, unknown>
      );

      if (!scanResult.clean) {
        // Log injection attempt — this is the adversarial demo moment
        await logAction({
          actor: "mandate_engine",
          tool: "injection_detected",
          input: {
            productId: product.id,
            productName: product.name,
            suspiciousField: scanResult.field,
            patternsFound: scanResult.patterns,
          },
          output: {
            action: "logged_and_ignored",
            note: "Injection payload in product catalog detected. Mandate engine ignores all text-based instructions — only structured tool-call amounts are evaluated.",
          },
          decision: "blocked",
          reason: `Prompt injection detected in product description field of "${product.name}". Patterns: ${scanResult.patterns.join(", ")}. Instruction ignored — mandate engine is deterministic and text-blind.`,
        });

        // Replace the adversarial description in the response with sanitized version
        product.description = scanResult.sanitizedText;
      }
    }

    // Clean catalog response — structured for agent consumption
    const catalog = {
      version: "1.0",
      currency: "INR",
      merchantName: "CartGuard Demo Store",
      description:
        "Running gear catalog. Products are categorized and priced in INR. Use the search_products tool to filter by category or price.",
      mandateHint: {
        budgetCapINR: 4000,
        perItemCapINR: 2500,
        allowedCategories: [
          "running_shoes",
          "apparel",
          "accessories",
          "nutrition",
        ],
        note: "These are the mandate limits applied at checkout. Budget is enforced deterministically, not by the LLM.",
      },
      totalProducts: products.length,
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        price: p.price,
        priceFormatted: `₹${p.price}`,
        category: p.category,
        inStock: p.inStock,
        imageUrl: p.imageUrl,
      })),
    };

    return NextResponse.json(catalog, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store", // Always fresh for agents
      },
    });
  } catch (error) {
    console.error("[/api/catalog.json]", error);
    return NextResponse.json(
      { error: "Failed to fetch catalog" },
      { status: 500 }
    );
  }
}
