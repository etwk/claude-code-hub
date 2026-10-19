import { extractCodexReasoningEffortInfo } from "@/lib/utils/codex-reasoning-effort";
import { normalizeThinkingConfigValue } from "@/lib/utils/native-thinking";
import { extractOpenAIReasoningEffortFromSpecialSettings } from "@/lib/utils/openai-reasoning-effort";
import type {
  NativeThinkingForwardedSpecialSetting,
  SpecialSetting,
  ThinkingConfigValue,
} from "@/types/special-settings";

export type ThinkingEffortSource = "codex" | "openai" | "anthropic" | "gemini";

/** Original and final observed configuration, shared by usage lists and request details. */
export interface ThinkingEffortInfo {
  source: ThinkingEffortSource;
  requested: ThinkingConfigValue | null;
  effective: ThinkingConfigValue | null;
  isOverridden: boolean;
}

function extractAnthropicThinkingInfo(
  specialSettings: SpecialSetting[]
): ThinkingEffortInfo | null {
  let nativeConfig: ThinkingConfigValue | null = null;
  let historicalEffort: string | null = null;
  for (const setting of specialSettings) {
    if (setting?.hit === false) continue;
    if (setting?.type === "native_thinking" && setting.protocol === "anthropic" && !nativeConfig) {
      nativeConfig = normalizeThinkingConfigValue(
        setting.config?.effort,
        setting.config?.mode,
        setting.config?.budgetTokens,
        "anthropic"
      );
    } else if (setting?.type === "anthropic_effort" && historicalEffort === null) {
      historicalEffort =
        normalizeThinkingConfigValue(setting.effort, null, null, "anthropic")?.effort ?? null;
    }
  }

  const requestedValues: Record<keyof ThinkingConfigValue, unknown> = {
    effort: nativeConfig ? nativeConfig.effort : historicalEffort,
    mode: nativeConfig?.mode ?? null,
    budgetTokens: nativeConfig?.budgetTokens ?? null,
  };
  const effectiveValues = { ...requestedValues };
  // A canonical request audit observes absence too. Older effort-only rows leave mode/budget
  // unknown, so the first relevant before value can recover those original fields.
  const observed = {
    effort: nativeConfig !== null || historicalEffort !== null,
    mode: nativeConfig !== null,
    budgetTokens: nativeConfig !== null,
  };
  const applyChange = (
    field: keyof ThinkingConfigValue,
    before: unknown,
    after: unknown,
    hasBefore: boolean,
    hasAfter: boolean
  ) => {
    if (!hasBefore && !hasAfter) return;
    if (!observed[field]) {
      observed[field] = true;
      if (hasBefore) {
        requestedValues[field] = before;
        effectiveValues[field] = before;
      }
    }
    if (hasAfter) effectiveValues[field] = after;
  };

  for (const setting of specialSettings) {
    if (!setting || setting.hit === false) continue;
    if (setting.type === "provider_parameter_override") {
      if (
        setting.providerType != null &&
        setting.providerType !== "claude" &&
        setting.providerType !== "claude-auth"
      ) {
        continue;
      }
      if (!Array.isArray(setting.changes)) continue;
      for (const change of setting.changes) {
        if (!change) continue;
        const field =
          change.path === "thinking.type"
            ? "mode"
            : change.path === "thinking.budget_tokens"
              ? "budgetTokens"
              : change.path === "output_config.effort"
                ? "effort"
                : null;
        if (field) {
          applyChange(
            field,
            change.before,
            change.after,
            Object.hasOwn(change, "before"),
            Object.hasOwn(change, "after")
          );
        }
      }
    } else if (setting.type === "thinking_budget_rectifier") {
      for (const [auditField, field] of [
        ["thinkingType", "mode"],
        ["thinkingBudgetTokens", "budgetTokens"],
      ] as const) {
        applyChange(
          field,
          setting.before?.[auditField],
          setting.after?.[auditField],
          setting.before != null && Object.hasOwn(setting.before, auditField),
          setting.after != null && Object.hasOwn(setting.after, auditField)
        );
      }
    } else if (
      setting.type === "thinking_effort_conflict_rectifier" &&
      setting.removedOutputConfigEffort
    ) {
      applyChange(
        "mode",
        setting.thinkingType,
        setting.thinkingType,
        Object.hasOwn(setting, "thinkingType"),
        Object.hasOwn(setting, "thinkingType")
      );
      applyChange("effort", setting.effort, null, Object.hasOwn(setting, "effort"), true);
    }
  }

  const requested = normalizeThinkingConfigValue(
    requestedValues.effort,
    requestedValues.mode,
    requestedValues.budgetTokens,
    "anthropic"
  );
  const effective = normalizeThinkingConfigValue(
    effectiveValues.effort,
    effectiveValues.mode,
    effectiveValues.budgetTokens,
    "anthropic"
  );
  if (!requested && !effective) return null;

  return {
    source: "anthropic",
    requested,
    effective,
    isOverridden:
      requested?.effort !== effective?.effort ||
      requested?.mode !== effective?.mode ||
      requested?.budgetTokens !== effective?.budgetTokens,
  };
}

function extractForwardedNativeThinkingInfo(
  specialSettings: SpecialSetting[],
  forwarded: NativeThinkingForwardedSpecialSetting
): ThinkingEffortInfo | null {
  let nativeConfig: ThinkingConfigValue | null = null;
  let historicalConfig: ThinkingConfigValue | null = null;
  for (const setting of specialSettings) {
    if (setting?.hit === false) continue;
    if (
      setting?.type === "native_thinking" &&
      setting.protocol === forwarded.protocol &&
      !nativeConfig
    ) {
      nativeConfig = normalizeThinkingConfigValue(
        setting.config?.effort,
        setting.config?.mode,
        setting.config?.budgetTokens,
        forwarded.protocol
      );
    } else if (
      forwarded.protocol === "anthropic" &&
      setting?.type === "anthropic_effort" &&
      !historicalConfig
    ) {
      historicalConfig = normalizeThinkingConfigValue(setting.effort, null, null, "anthropic");
    }
  }

  // Diagnostic retries can belong to a losing provider. Only request audits establish the
  // original configuration once the selected outgoing request has been observed directly.
  const requested = nativeConfig ?? historicalConfig;
  const effective = normalizeThinkingConfigValue(
    forwarded.config?.effort,
    forwarded.config?.mode,
    forwarded.config?.budgetTokens,
    forwarded.protocol
  );
  if (!requested && !effective) return null;

  return {
    source: forwarded.protocol,
    requested,
    effective,
    isOverridden:
      requested?.effort !== effective?.effort ||
      requested?.mode !== effective?.mode ||
      requested?.budgetTokens !== effective?.budgetTokens,
  };
}

/** Audit precedence stays Codex, OpenAI, then native Gemini/Anthropic (including legacy rows). */
export function extractThinkingEffortInfo(
  specialSettings: SpecialSetting[] | null | undefined
): ThinkingEffortInfo | null {
  if (!Array.isArray(specialSettings) || specialSettings.length === 0) return null;

  const codexInfo = extractCodexReasoningEffortInfo(specialSettings);
  if (codexInfo) {
    return {
      source: "codex",
      requested: normalizeThinkingConfigValue(codexInfo.requestedEffort, null, null, "anthropic"),
      effective: normalizeThinkingConfigValue(codexInfo.effectiveEffort, null, null, "anthropic"),
      isOverridden: codexInfo.isOverridden,
    };
  }

  const openaiInfo = extractOpenAIReasoningEffortFromSpecialSettings(specialSettings);
  if (openaiInfo) {
    const config = normalizeThinkingConfigValue(openaiInfo.effort, null, null, "anthropic");
    return { source: "openai", requested: config, effective: config, isOverridden: false };
  }

  // Absence is an authoritative observation too; never fall back to replaying diagnostic
  // provider/rectifier audits when the selected outgoing request has no native configuration.
  for (let index = specialSettings.length - 1; index >= 0; index--) {
    const setting = specialSettings[index];
    if (setting?.hit === false) continue;
    if (
      setting?.type === "native_thinking_forwarded" &&
      (setting.protocol === "anthropic" || setting.protocol === "gemini")
    ) {
      return extractForwardedNativeThinkingInfo(specialSettings, setting);
    }
  }

  for (const setting of specialSettings) {
    if (
      setting?.type !== "native_thinking" ||
      setting.protocol !== "gemini" ||
      setting.hit === false
    ) {
      continue;
    }
    const config = normalizeThinkingConfigValue(
      setting.config?.effort,
      setting.config?.mode,
      setting.config?.budgetTokens,
      "gemini"
    );
    if (config) {
      return { source: "gemini", requested: config, effective: config, isOverridden: false };
    }
  }

  return extractAnthropicThinkingInfo(specialSettings);
}
