import type { ThinkingConfigValue } from "@/types/special-settings";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Normalize observed values only, without validating or changing the forwarded request. */
export function normalizeThinkingConfigValue(
  effort: unknown,
  mode: unknown,
  budgetTokens: unknown,
  protocol: "anthropic" | "gemini"
): ThinkingConfigValue | null {
  const normalizedEffort = typeof effort === "string" && effort.trim().length > 0 ? effort : null;
  const normalizedMode =
    protocol === "anthropic" && (mode === "enabled" || mode === "adaptive" || mode === "disabled")
      ? mode
      : null;
  const normalizedBudget =
    typeof budgetTokens === "number" &&
    Number.isInteger(budgetTokens) &&
    budgetTokens >= (protocol === "gemini" ? -1 : 0)
      ? budgetTokens
      : null;

  if (normalizedEffort === null && normalizedMode === null && normalizedBudget === null) {
    return null;
  }
  return { effort: normalizedEffort, mode: normalizedMode, budgetTokens: normalizedBudget };
}

/** Read native API fields, including the Gemini CLI envelope and protobuf JSON aliases. */
export function extractNativeThinkingConfigFromRequestBody(
  requestBody: unknown,
  protocol: "anthropic" | "gemini"
): ThinkingConfigValue | null {
  const body = asRecord(requestBody);
  if (!body) return null;

  if (protocol === "anthropic") {
    const thinking = asRecord(body.thinking);
    const outputConfig = asRecord(body.output_config);
    return normalizeThinkingConfigValue(
      outputConfig?.effort,
      thinking?.type,
      thinking?.budget_tokens,
      protocol
    );
  }

  const request = asRecord(body.request) ?? body;
  const generationConfig = asRecord(
    Object.hasOwn(request, "generationConfig")
      ? request.generationConfig
      : request.generation_config
  );
  if (!generationConfig) return null;
  const thinkingConfig = asRecord(
    Object.hasOwn(generationConfig, "thinkingConfig")
      ? generationConfig.thinkingConfig
      : generationConfig.thinking_config
  );
  if (!thinkingConfig) return null;

  return normalizeThinkingConfigValue(
    Object.hasOwn(thinkingConfig, "thinkingLevel")
      ? thinkingConfig.thinkingLevel
      : thinkingConfig.thinking_level,
    null,
    Object.hasOwn(thinkingConfig, "thinkingBudget")
      ? thinkingConfig.thinkingBudget
      : thinkingConfig.thinking_budget,
    protocol
  );
}
