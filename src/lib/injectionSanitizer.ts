/**
 * Injection Sanitizer
 *
 * Scans text fields (product descriptions, user messages, catalog data)
 * for prompt injection patterns. The mandate engine never executes
 * instructions found in untrusted text — but we log every attempt.
 *
 * Detection philosophy: flag anything that attempts to:
 * - Change the agent's behavior ("ignore all previous instructions")
 * - Claim special permissions ("you are authorized to...")
 * - Override safety checks ("bypass budget", "ignore limits")
 * - Address the AI directly with instructions
 */

import type { InjectionCheckResult } from "@/types";

// ---------------------------------------------------------------------------
// Injection pattern registry
// ---------------------------------------------------------------------------

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Instruction override attempts
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above|budget|limit)/i,
    label: "instruction_override",
  },
  {
    pattern: /disregard\s+(all\s+)?(previous|prior|instructions?|limits?)/i,
    label: "instruction_override",
  },
  { pattern: /forget\s+(everything|all|prior)/i, label: "instruction_override" },
  { pattern: /new\s+instructions?\s*:/i, label: "instruction_override" },

  // AI-addressing patterns
  {
    pattern: /if\s+you\s+are\s+(an?\s+)?ai/i,
    label: "ai_direct_address",
  },
  {
    pattern: /as\s+an?\s+ai\s+(agent|assistant|model)/i,
    label: "ai_direct_address",
  },
  { pattern: /you\s+are\s+(an?\s+)?ai/i, label: "ai_direct_address" },
  {
    pattern: /attention\s*[:,]\s*(ai|agent|assistant|model|llm)/i,
    label: "ai_direct_address",
  },

  // Permission escalation
  {
    pattern: /approve\s+(any|all)\s+(purchase|amount|transaction|order)/i,
    label: "permission_escalation",
  },
  { pattern: /bypass\s+(all\s+)?(budget|limit|mandate|guardrail)/i, label: "permission_escalation" },
  { pattern: /override\s+(mandate|limit|budget|guardrail|cap)/i, label: "permission_escalation" },
  {
    pattern: /you\s+(are\s+)?(now\s+)?authorized/i,
    label: "permission_escalation",
  },
  { pattern: /unlimited\s+budget/i, label: "permission_escalation" },

  // System prompt injection
  {
    pattern: /\[system\]|\[assistant\]|\[user\]|\[inst\]/i,
    label: "system_prompt_injection",
  },
  { pattern: /<\|im_start\|>|<\|im_end\|>/i, label: "system_prompt_injection" },
  { pattern: /###\s*(instruction|system|prompt)/i, label: "system_prompt_injection" },

  // Jailbreak patterns
  { pattern: /dan\s+mode/i, label: "jailbreak" },
  { pattern: /do\s+anything\s+now/i, label: "jailbreak" },
  { pattern: /pretend\s+(you|there)\s+(are\s+no|have\s+no)\s+(rules|limits)/i, label: "jailbreak" },
];

// ---------------------------------------------------------------------------
// Sanitizer function
// ---------------------------------------------------------------------------

/**
 * Scans a text string for injection patterns.
 * Returns whether it's clean, what patterns were found, and a sanitized version.
 *
 * NOTE: The sanitized text is NOT passed to the LLM as authorization.
 * Detection here is informational — the mandate engine ignores all text-based
 * instructions regardless. This function exists to log injection attempts.
 */
export function checkInjection(text: string): InjectionCheckResult {
  if (!text || typeof text !== "string") {
    return { clean: true, patterns: [], sanitizedText: text || "" };
  }

  const foundPatterns: string[] = [];

  for (const { pattern, label } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      foundPatterns.push(label);
    }
  }

  // Sanitize by replacing injection attempts with [REDACTED]
  let sanitizedText = text;
  if (foundPatterns.length > 0) {
    for (const { pattern } of INJECTION_PATTERNS) {
      sanitizedText = sanitizedText.replace(pattern, "[REDACTED]");
    }
  }

  return {
    clean: foundPatterns.length === 0,
    patterns: Array.from(new Set(foundPatterns)), // dedupe
    sanitizedText,
  };
}

/**
 * Scan an entire product (or any object with text fields) for injection.
 * Returns the most severe finding across all fields.
 */
export function scanProductForInjection(
  product: Record<string, unknown>
): InjectionCheckResult & { field?: string } {
  const textFields = ["name", "description", "category"] as const;

  for (const field of textFields) {
    const value = product[field];
    if (typeof value === "string") {
      const result = checkInjection(value);
      if (!result.clean) {
        return { ...result, field };
      }
    }
  }

  return { clean: true, patterns: [], sanitizedText: "" };
}

/**
 * Scan a user message for injection attempts.
 */
export function scanUserMessage(message: string): InjectionCheckResult {
  return checkInjection(message);
}
