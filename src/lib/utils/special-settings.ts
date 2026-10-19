import type { SpecialSetting } from "@/types/special-settings";

type BuildUnifiedSpecialSettingsParams = {
  /**
   * 已有 specialSettings（通常来自 DB special_settings 或 Session Redis 缓存）
   */
  existing?: SpecialSetting[] | null;
  /**
   * 拦截类型（如 warmup / sensitive_word）
   */
  blockedBy?: string | null;
  /**
   * 拦截原因（通常为 JSON 字符串）
   */
  blockedReason?: string | null;
  /**
   * HTTP 状态码（用于补齐守卫拦截信息）
   */
  statusCode?: number | null;
  /**
   * Cache TTL 实际应用值（用于展示 TTL/标头覆写命中）
   */
  cacheTtlApplied?: string | null;
  /**
   * 1M 上下文是否应用（保留参数用于兼容调用方；不再自动派生 header 覆写审计）
   */
  context1mApplied?: boolean | null;
};

function buildSettingKey(setting: SpecialSetting): string {
  switch (setting.type) {
    case "provider_parameter_override":
      return JSON.stringify([
        setting.type,
        setting.providerId ?? null,
        setting.providerType ?? null,
        setting.hit,
        setting.changed,
        (Array.isArray(setting.changes) ? setting.changes : [])
          .map(
            (change) =>
              [
                change.path,
                change.before,
                change.after,
                change.changed,
                Object.hasOwn(change, "after"),
              ] as const
          )
          .sort((a, b) => a[0].localeCompare(b[0])),
      ]);
    case "response_fixer":
      return JSON.stringify([
        setting.type,
        setting.hit,
        [...setting.fixersApplied]
          .map((fixer) => [fixer.fixer, fixer.applied] as const)
          .sort((a, b) => a[0].localeCompare(b[0])),
      ]);
    case "guard_intercept":
      return JSON.stringify([setting.type, setting.guard, setting.action, setting.statusCode]);
    case "anthropic_effort":
      return JSON.stringify([setting.type, setting.hit, setting.effort]);
    case "native_thinking":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.protocol,
        setting.config?.effort ?? null,
        setting.config?.mode ?? null,
        setting.config?.budgetTokens ?? null,
      ]);
    case "native_thinking_forwarded":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.protocol,
        setting.providerId,
        setting.config == null
          ? null
          : [
              setting.config.effort ?? null,
              setting.config.mode ?? null,
              setting.config.budgetTokens ?? null,
            ],
      ]);
    case "codex_reasoning_effort":
      return JSON.stringify([setting.type, setting.hit, setting.effort]);
    case "openai_reasoning_effort":
      return JSON.stringify([setting.type, setting.hit, setting.effort, setting.source]);
    case "anthropic_cache_ttl_header_override":
      return JSON.stringify([setting.type, setting.ttl]);
    case "anthropic_context_1m_header_override":
      return JSON.stringify([setting.type, setting.header, setting.flag]);
    case "long_context_pricing":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.pricingScope ?? null,
        setting.thresholdTokens ?? null,
      ]);
    case "thinking_signature_rectifier":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.providerId ?? null,
        setting.trigger,
        setting.attemptNumber,
        setting.retryAttemptNumber,
        setting.removedThinkingBlocks,
        setting.removedRedactedThinkingBlocks,
        setting.removedSignatureFields,
      ]);
    case "thinking_effort_conflict_rectifier":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.providerId ?? null,
        setting.trigger,
        setting.attemptNumber,
        setting.retryAttemptNumber,
        setting.removedOutputConfigEffort,
        setting.removedReasoningEffort,
        setting.thinkingType,
        setting.effort,
      ]);
    case "codex_session_id_completion":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.action,
        setting.source,
        setting.sessionId,
      ]);
    case "claude_metadata_user_id_injection":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.action,
        setting.reason,
        setting.keyId,
        setting.sessionId,
      ]);
    case "thinking_budget_rectifier":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.providerId ?? null,
        setting.trigger,
        setting.attemptNumber,
        setting.retryAttemptNumber,
        setting.before?.maxTokens,
        setting.before?.thinkingType,
        setting.before?.thinkingBudgetTokens,
        setting.after?.maxTokens,
        setting.after?.thinkingType,
        setting.after?.thinkingBudgetTokens,
        setting.after != null && Object.hasOwn(setting.after, "thinkingType"),
        setting.after != null && Object.hasOwn(setting.after, "thinkingBudgetTokens"),
      ]);
    case "billing_header_rectifier":
      return JSON.stringify([setting.type, setting.hit, setting.removedCount]);
    case "gemini_function_id_rectifier":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.providerId ?? null,
        setting.trigger,
        setting.attemptNumber,
        setting.retryAttemptNumber,
        setting.strippedFunctionCallIds,
        setting.strippedFunctionResponseIds,
      ]);
    case "gemini_google_search_override":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.providerId ?? null,
        setting.action,
        setting.preference,
        setting.hadGoogleSearchInRequest,
      ]);
    case "pricing_resolution":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.modelName,
        setting.resolvedModelName,
        setting.resolvedPricingProviderKey,
        setting.source,
      ]);
    case "codex_service_tier_result":
      return JSON.stringify([
        setting.type,
        setting.hit,
        setting.requestedServiceTier,
        setting.actualServiceTier,
        setting.billingSourcePreference ?? null,
        setting.resolvedFrom ?? null,
        setting.effectivePriority,
      ]);
    case "response_input_rectifier":
      return JSON.stringify([setting.type, setting.hit, setting.action, setting.originalType]);
    case "thinking_signature_model_detection":
      return JSON.stringify([
        setting.type,
        setting.source,
        setting.signatureFound,
        setting.thinkingEnabled,
        setting.extractedModel,
        setting.requestedModel,
      ]);
    default: {
      // 兜底：保证即使未来扩展类型也不会导致运行时崩溃
      const _exhaustive: never = setting;
      return JSON.stringify(_exhaustive);
    }
  }
}

/**
 * Reconcile independent snapshots of the same audit history before display deduplication.
 * A shortest common supersequence aligns shared events while retaining their observed order,
 * including repeated transitions within either snapshot (for example A-B-A).
 * Earlier snapshots take precedence when the relative order of new events is unknown.
 * The first snapshot with a forwarded observation owns that current state; later snapshots
 * contribute diagnostic history but cannot resurrect a stale forwarded configuration.
 */
export function mergeSpecialSettingSnapshots(
  snapshots: ReadonlyArray<readonly SpecialSetting[] | null | undefined>
): SpecialSetting[] {
  let merged: SpecialSetting[] = [];
  let mergedKeys: string[] = [];
  let hasForwardedObservation = false;

  for (const source of snapshots) {
    if (!source?.length) continue;
    const containsForwarded = source.some(
      (setting) => setting.type === "native_thinking_forwarded" && setting.hit
    );
    const snapshot =
      hasForwardedObservation && containsForwarded
        ? source.filter((setting) => setting.type !== "native_thinking_forwarded")
        : source;
    hasForwardedObservation ||= containsForwarded;
    const snapshotKeys = snapshot.map(buildSettingKey);
    if (merged.length === 0) {
      merged = [...snapshot];
      mergedKeys = snapshotKeys;
      continue;
    }
    let commonPrefix = 0;
    while (
      commonPrefix < merged.length &&
      commonPrefix < snapshot.length &&
      mergedKeys[commonPrefix] === snapshotKeys[commonPrefix]
    ) {
      commonPrefix++;
    }
    if (commonPrefix === snapshot.length) continue;
    if (commonPrefix === merged.length) {
      for (let index = commonPrefix; index < snapshot.length; index++) {
        merged.push(snapshot[index]);
      }
      mergedKeys = snapshotKeys;
      continue;
    }

    const width = snapshot.length + 1;
    const commonLengths = new Uint32Array((merged.length + 1) * width);
    for (let left = merged.length - 1; left >= 0; left--) {
      for (let right = snapshot.length - 1; right >= 0; right--) {
        commonLengths[left * width + right] =
          mergedKeys[left] === snapshotKeys[right]
            ? 1 + commonLengths[(left + 1) * width + right + 1]
            : Math.max(
                commonLengths[(left + 1) * width + right],
                commonLengths[left * width + right + 1]
              );
      }
    }

    const combined: SpecialSetting[] = [];
    const combinedKeys: string[] = [];
    let left = 0;
    let right = 0;
    while (left < merged.length || right < snapshot.length) {
      if (
        left < merged.length &&
        right < snapshot.length &&
        mergedKeys[left] === snapshotKeys[right]
      ) {
        combined.push(merged[left]);
        combinedKeys.push(mergedKeys[left]);
        left++;
        right++;
      } else if (
        left < merged.length &&
        (right === snapshot.length ||
          commonLengths[(left + 1) * width + right] >= commonLengths[left * width + right + 1])
      ) {
        combined.push(merged[left]);
        combinedKeys.push(mergedKeys[left]);
        left++;
      } else {
        combined.push(snapshot[right]);
        combinedKeys.push(snapshotKeys[right]);
        right++;
      }
    }
    merged = combined;
    mergedKeys = combinedKeys;
  }

  return merged;
}

/**
 * 构建“统一特殊设置”展示数据
 *
 * 目标：把 DB 字段（blockedBy/cacheTtlApplied/context1mApplied）与既有 special_settings 合并，
 * 统一在以下位置展示：日志列表/日志详情弹窗/Session 详情页。
 */
export function buildUnifiedSpecialSettings(
  params: BuildUnifiedSpecialSettingsParams
): SpecialSetting[] | null {
  const base = params.existing ?? [];
  const derived: SpecialSetting[] = [];

  if (params.blockedBy) {
    const guard = params.blockedBy;
    const action = guard === "warmup" ? "intercept_response" : "block_request";

    derived.push({
      type: "guard_intercept",
      scope: "guard",
      hit: true,
      guard,
      action,
      statusCode: params.statusCode ?? null,
      reason: params.blockedReason ?? null,
    });
  }

  if (params.cacheTtlApplied) {
    derived.push({
      type: "anthropic_cache_ttl_header_override",
      scope: "request_header",
      hit: true,
      ttl: params.cacheTtlApplied,
    });
  }

  if (base.length === 0 && derived.length === 0) {
    return null;
  }

  const seen = new Set<string>();
  const result: SpecialSetting[] = [];
  let previousKey: string | null = null;
  for (const item of [...base, ...derived]) {
    const key = buildSettingKey(item);
    const isOrderedTransition =
      item.type === "provider_parameter_override" ||
      item.type === "thinking_budget_rectifier" ||
      item.type === "thinking_effort_conflict_rectifier";
    if (isOrderedTransition ? previousKey === key : seen.has(key)) continue;
    previousKey = key;
    seen.add(key);
    result.push(item);
  }

  return result.length > 0 ? result : null;
}

export function hasPriorityServiceTierSpecialSetting(
  specialSettings?: SpecialSetting[] | null
): boolean {
  if (!Array.isArray(specialSettings) || specialSettings.length === 0) {
    return false;
  }

  const codexServiceTierResult = specialSettings.find(
    (setting): setting is Extract<SpecialSetting, { type: "codex_service_tier_result" }> =>
      setting.type === "codex_service_tier_result"
  );
  if (codexServiceTierResult) {
    if (
      codexServiceTierResult.billingSourcePreference == null &&
      codexServiceTierResult.resolvedFrom == null &&
      codexServiceTierResult.actualServiceTier != null
    ) {
      return codexServiceTierResult.actualServiceTier === "priority";
    }
    return codexServiceTierResult.effectivePriority;
  }

  return specialSettings.some(
    (setting) =>
      setting.type === "provider_parameter_override" &&
      setting.providerType === "codex" &&
      setting.changes.some(
        (change) => change.path === "service_tier" && change.after === "priority"
      )
  );
}

export function getPriorityServiceTierSpecialSetting(
  specialSettings?: SpecialSetting[] | null
): Extract<SpecialSetting, { type: "codex_service_tier_result" }> | null {
  if (!Array.isArray(specialSettings) || specialSettings.length === 0) {
    return null;
  }

  return (
    specialSettings.find(
      (setting): setting is Extract<SpecialSetting, { type: "codex_service_tier_result" }> =>
        setting.type === "codex_service_tier_result"
    ) ?? null
  );
}

export function getPricingResolutionSpecialSetting(
  specialSettings?: SpecialSetting[] | null
): Extract<SpecialSetting, { type: "pricing_resolution" }> | null {
  if (!Array.isArray(specialSettings) || specialSettings.length === 0) {
    return null;
  }

  return (
    specialSettings.find(
      (setting): setting is Extract<SpecialSetting, { type: "pricing_resolution" }> =>
        setting.type === "pricing_resolution"
    ) ?? null
  );
}

export function getThinkingSignatureModelDetectionSpecialSetting(
  specialSettings?: SpecialSetting[] | null
): Extract<SpecialSetting, { type: "thinking_signature_model_detection" }> | null {
  if (!Array.isArray(specialSettings) || specialSettings.length === 0) {
    return null;
  }

  return (
    specialSettings.find(
      (
        setting
      ): setting is Extract<SpecialSetting, { type: "thinking_signature_model_detection" }> =>
        setting.type === "thinking_signature_model_detection"
    ) ?? null
  );
}
