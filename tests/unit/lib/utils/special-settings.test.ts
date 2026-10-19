import { describe, expect, test } from "vitest";
import type { SpecialSetting } from "@/types/special-settings";
import {
  buildUnifiedSpecialSettings,
  hasPriorityServiceTierSpecialSetting,
  mergeSpecialSettingSnapshots,
} from "@/lib/utils/special-settings";

describe("buildUnifiedSpecialSettings", () => {
  test("无任何输入时应返回 null", () => {
    expect(buildUnifiedSpecialSettings({ existing: null })).toBe(null);
  });

  test("blockedBy=warmup 时应派生 guard_intercept 特殊设置", () => {
    const settings = buildUnifiedSpecialSettings({
      existing: null,
      blockedBy: "warmup",
      blockedReason: JSON.stringify({ reason: "anthropic_warmup_intercepted" }),
      statusCode: 200,
    });

    expect(settings).not.toBeNull();
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "guard_intercept",
          scope: "guard",
          hit: true,
          guard: "warmup",
          action: "intercept_response",
          statusCode: 200,
        }),
      ])
    );
  });

  test("blockedBy=sensitive_word 时应派生 guard_intercept 特殊设置", () => {
    const settings = buildUnifiedSpecialSettings({
      existing: null,
      blockedBy: "sensitive_word",
      blockedReason: JSON.stringify({ word: "x" }),
      statusCode: 400,
    });

    expect(settings).not.toBeNull();
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "guard_intercept",
          scope: "guard",
          hit: true,
          guard: "sensitive_word",
          action: "block_request",
          statusCode: 400,
        }),
      ])
    );
  });

  test("cacheTtlApplied 存在时应派生 anthropic_cache_ttl_header_override 特殊设置", () => {
    const settings = buildUnifiedSpecialSettings({
      existing: null,
      cacheTtlApplied: "1h",
    });

    expect(settings).not.toBeNull();
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "anthropic_cache_ttl_header_override",
          scope: "request_header",
          hit: true,
          ttl: "1h",
        }),
      ])
    );
  });

  test("context1mApplied=true no longer derives header override (1M context GA)", () => {
    const settings = buildUnifiedSpecialSettings({
      existing: null,
      context1mApplied: true,
    });

    expect(settings).toBe(null);
  });

  test("应合并 existing specialSettings 与派生 specialSettings", () => {
    const existing: SpecialSetting[] = [
      {
        type: "provider_parameter_override",
        scope: "provider",
        providerId: 1,
        providerName: "p",
        providerType: "codex",
        hit: true,
        changed: true,
        changes: [{ path: "temperature", before: 1, after: 0.2, changed: true }],
      },
    ];

    const settings = buildUnifiedSpecialSettings({
      existing,
      blockedBy: "warmup",
      blockedReason: JSON.stringify({ reason: "anthropic_warmup_intercepted" }),
      statusCode: 200,
    });

    expect(settings).not.toBeNull();
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "provider_parameter_override" }),
        expect.objectContaining({ type: "guard_intercept", guard: "warmup" }),
      ])
    );
  });

  test("应对重复的派生项去重（例如 existing 已包含同类 guard_intercept）", () => {
    const existing: SpecialSetting[] = [
      {
        type: "guard_intercept",
        scope: "guard",
        hit: true,
        guard: "warmup",
        action: "intercept_response",
        statusCode: 200,
        reason: JSON.stringify({ reason: "anthropic_warmup_intercepted" }),
      },
    ];

    const settings = buildUnifiedSpecialSettings({
      existing,
      blockedBy: "warmup",
      blockedReason: JSON.stringify({ reason: "anthropic_warmup_intercepted" }),
      statusCode: 200,
    });

    expect(settings).not.toBeNull();
    expect(settings?.filter((s) => s.type === "guard_intercept").length).toBe(1);
  });

  test("guard_intercept 去重时不应受 reason 差异影响", () => {
    const existing: SpecialSetting[] = [
      {
        type: "guard_intercept",
        scope: "guard",
        hit: true,
        guard: "warmup",
        action: "intercept_response",
        statusCode: 200,
        reason: JSON.stringify({ reason: "a" }),
      },
    ];

    const settings = buildUnifiedSpecialSettings({
      existing,
      blockedBy: "warmup",
      blockedReason: JSON.stringify({ reason: "b" }),
      statusCode: 200,
    });

    expect(settings).not.toBeNull();
    expect(settings?.filter((s) => s.type === "guard_intercept").length).toBe(1);
  });

  test("native audit dedup includes protocol, effort, mode, budget and hit", () => {
    const original: SpecialSetting = {
      type: "native_thinking",
      scope: "request",
      hit: true,
      protocol: "anthropic",
      config: { effort: "high", mode: "enabled", budgetTokens: 8192 },
    };
    const existing: SpecialSetting[] = [
      original,
      { ...original, config: { budgetTokens: 8192, mode: "enabled", effort: "high" } },
      { ...original, protocol: "gemini" },
      { ...original, config: { ...original.config, effort: "HIGH" } },
      { ...original, config: { ...original.config, mode: "disabled" } },
      { ...original, config: { ...original.config, budgetTokens: 0 } },
      { ...original, config: { ...original.config, budgetTokens: -1 } },
      { ...original, config: { ...original.config, budgetTokens: null } },
      { ...original, hit: false },
    ];
    const before = JSON.stringify(existing);

    expect(buildUnifiedSpecialSettings({ existing })).toEqual([original, ...existing.slice(2)]);
    expect(JSON.stringify(existing)).toBe(before);
  });

  test("forwarded audit dedup includes provider, protocol and explicit configuration absence", () => {
    const config = { effort: "high", mode: "enabled" as const, budgetTokens: 8192 };
    const original: Extract<SpecialSetting, { type: "native_thinking_forwarded" }> = {
      type: "native_thinking_forwarded",
      scope: "provider",
      hit: true,
      protocol: "anthropic",
      providerId: 1,
      config,
    };
    const existing: SpecialSetting[] = [
      original,
      { ...original, config: { budgetTokens: 8192, mode: "enabled", effort: "high" } },
      { ...original, providerId: 2 },
      { ...original, protocol: "gemini" },
      { ...original, config: { ...config, effort: "HIGH" } },
      { ...original, config: { ...config, mode: "disabled" } },
      { ...original, config: { ...config, budgetTokens: 0 } },
      { ...original, config: { ...config, budgetTokens: -1 } },
      { ...original, config: { ...config, budgetTokens: null } },
      { ...original, config: null },
      { ...original, config: null },
      { ...original, config: { effort: null, mode: null, budgetTokens: null } },
    ];
    const before = JSON.stringify(existing);

    expect(buildUnifiedSpecialSettings({ existing })).toEqual([
      original,
      ...existing.slice(2, 10),
      existing[11],
    ]);
    expect(JSON.stringify(existing)).toBe(before);
  });

  test("budget rectifier dedup retains distinct observed thinking modes", () => {
    const original: SpecialSetting = {
      type: "thinking_budget_rectifier",
      scope: "request",
      hit: true,
      providerId: 1,
      providerName: "provider",
      trigger: "budget_tokens_too_low",
      attemptNumber: 1,
      retryAttemptNumber: 2,
      before: { maxTokens: 64000, thinkingType: "disabled", thinkingBudgetTokens: 32000 },
      after: { maxTokens: 64000, thinkingType: "enabled", thinkingBudgetTokens: 32000 },
    };
    const differentBefore: SpecialSetting = {
      ...original,
      before: { ...original.before, thinkingType: "adaptive" },
    };
    const differentAfter: SpecialSetting = {
      ...original,
      after: { ...original.after, thinkingType: "disabled" },
    };
    expect(
      buildUnifiedSpecialSettings({
        existing: [original, original, differentBefore, differentAfter],
      })
    ).toEqual([original, differentBefore, differentAfter]);
  });

  test("identical chronological overrides collapse only adjacent repetitions", () => {
    const first: SpecialSetting = {
      type: "provider_parameter_override",
      scope: "provider",
      hit: true,
      changed: true,
      providerId: 1,
      providerName: "provider",
      providerType: "claude",
      changes: [{ path: "output_config.effort", before: "low", after: "high", changed: true }],
    };
    const second: SpecialSetting = {
      ...first,
      changes: [{ path: "output_config.effort", before: "high", after: "max", changed: true }],
    };
    expect(buildUnifiedSpecialSettings({ existing: [first, first, second, first] })).toEqual([
      first,
      second,
      first,
    ]);
  });

  test("partial historical provider and budget audits do not fail deduplication", () => {
    const existing = [
      { type: "provider_parameter_override", hit: true },
      { type: "thinking_budget_rectifier", hit: true, after: { thinkingBudgetTokens: 32000 } },
    ] as SpecialSetting[];
    expect(buildUnifiedSpecialSettings({ existing })).toEqual(existing);
  });
});

describe("mergeSpecialSettingSnapshots", () => {
  function override(effort: string): SpecialSetting {
    return {
      type: "provider_parameter_override",
      scope: "provider",
      hit: true,
      changed: true,
      providerId: 1,
      providerName: "provider",
      providerType: "claude",
      changes: [{ path: "output_config.effort", before: "low", after: effort, changed: true }],
    };
  }

  const first = override("medium");
  const second = override("high");
  const third = override("max");
  const fourth = override("low");

  test.each<{
    name: string;
    snapshots: ReadonlyArray<readonly SpecialSetting[] | null | undefined>;
    expected: SpecialSetting[];
  }>([
    { name: "absent snapshots", snapshots: [null, undefined, []], expected: [] },
    {
      name: "identical independent histories",
      snapshots: [[first, second], JSON.parse(JSON.stringify([first, second]))],
      expected: [first, second],
    },
    {
      name: "a later snapshot extends the history",
      snapshots: [
        [first, second],
        [first, second, third],
      ],
      expected: [first, second, third],
    },
    {
      name: "an earlier snapshot contains the history",
      snapshots: [
        [first, second, third],
        [first, second],
      ],
      expected: [first, second, third],
    },
    {
      name: "an incomplete history omits an internal event",
      snapshots: [
        [first, third],
        [first, second, third],
      ],
      expected: [first, second, third],
    },
    {
      name: "a complete history precedes its incomplete snapshot",
      snapshots: [
        [first, second, third],
        [first, third],
      ],
      expected: [first, second, third],
    },
    {
      name: "suffix and prefix overlap",
      snapshots: [
        [first, second],
        [second, third],
      ],
      expected: [first, second, third],
    },
    {
      name: "overlapping history starts earlier in the later snapshot",
      snapshots: [
        [second, third],
        [first, second],
      ],
      expected: [first, second, third],
    },
    {
      name: "both snapshots supply missing internal events",
      snapshots: [
        [first, second, fourth],
        [second, third, fourth],
      ],
      expected: [first, second, third, fourth],
    },
    {
      name: "independent extensions retain stable input order",
      snapshots: [
        [first, second],
        [first, third],
      ],
      expected: [first, second, third],
    },
    {
      name: "disjoint histories retain stable input order",
      snapshots: [
        [first, second],
        [third, fourth],
      ],
      expected: [first, second, third, fourth],
    },
    {
      name: "a genuine A-B-A is retained in identical snapshots",
      snapshots: [
        [first, second, first],
        [first, second, first],
      ],
      expected: [first, second, first],
    },
    {
      name: "a later snapshot adds a genuine return transition",
      snapshots: [
        [first, second],
        [first, second, first],
      ],
      expected: [first, second, first],
    },
    {
      name: "an earlier snapshot already contains a genuine return transition",
      snapshots: [
        [first, second, first],
        [first, second],
      ],
      expected: [first, second, first],
    },
    {
      name: "multiple snapshots extend the same shared history",
      snapshots: [
        [first, second],
        [second, third],
        [first, second, third, fourth],
      ],
      expected: [first, second, third, fourth],
    },
  ])("reconciles $name", ({ snapshots, expected }) => {
    expect(mergeSpecialSettingSnapshots(snapshots)).toEqual(expected);
  });

  test("keeps per-history repetitions for chronological deduplication without mutating snapshots", () => {
    const snapshot = Object.freeze([first, first, second, first]);
    const before = JSON.stringify(snapshot);
    const merged = mergeSpecialSettingSnapshots([null, snapshot, undefined]);

    expect(merged).toEqual(snapshot);
    expect(merged).not.toBe(snapshot);
    expect(merged[0]).toBe(first);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(buildUnifiedSpecialSettings({ existing: merged })).toEqual([first, second, first]);
  });

  test("does not change global deduplication of unrelated settings", () => {
    const guard: SpecialSetting = {
      type: "guard_intercept",
      scope: "guard",
      hit: true,
      guard: "warmup",
      action: "intercept_response",
      statusCode: 200,
      reason: null,
    };
    const merged = mergeSpecialSettingSnapshots([
      [guard, first, second, first, guard],
      [guard, first, second],
    ]);

    expect(buildUnifiedSpecialSettings({ existing: merged })).toEqual([
      guard,
      first,
      second,
      first,
    ]);
  });

  test.each([
    {
      name: "the selected provider's budget",
      config: { effort: null, mode: "enabled", budgetTokens: 500 },
    },
    { name: "explicit configuration removal", config: null },
  ])("keeps $name authoritative over a stale snapshot", ({ config }) => {
    const current: SpecialSetting = {
      type: "native_thinking_forwarded",
      scope: "provider",
      hit: true,
      protocol: "anthropic",
      providerId: 6,
      config,
    };
    const stale: SpecialSetting = {
      ...current,
      providerId: 5,
      config: { effort: null, mode: "enabled", budgetTokens: 32000 },
    };

    const merged = mergeSpecialSettingSnapshots([
      [first, current],
      [first, second, stale, third],
    ]);

    expect(merged.filter((setting) => setting.type === "native_thinking_forwarded")).toEqual([
      current,
    ]);
    expect(merged.filter((setting) => setting.type === "provider_parameter_override")).toEqual([
      first,
      second,
      third,
    ]);
  });

  test("uses a later snapshot when the earlier history has no forwarded observation", () => {
    const forwarded: SpecialSetting = {
      type: "native_thinking_forwarded",
      scope: "provider",
      hit: true,
      protocol: "gemini",
      providerId: 3,
      config: { effort: null, mode: null, budgetTokens: 0 },
    };

    expect(
      mergeSpecialSettingSnapshots([
        [first, second],
        [first, forwarded],
      ])
    ).toEqual([first, second, forwarded]);
  });
});

describe("hasPriorityServiceTierSpecialSetting", () => {
  test("returns true when codex actual service tier is priority", () => {
    expect(
      hasPriorityServiceTierSpecialSetting([
        {
          type: "codex_service_tier_result",
          scope: "response",
          hit: true,
          requestedServiceTier: "default",
          actualServiceTier: "priority",
          billingSourcePreference: "actual",
          resolvedFrom: "actual",
          effectivePriority: true,
        },
      ])
    ).toBe(true);
  });

  test("returns true when billing follows requested priority even if actual tier is downgraded", () => {
    expect(
      hasPriorityServiceTierSpecialSetting([
        {
          type: "provider_parameter_override",
          scope: "provider",
          providerId: 1,
          providerName: "p",
          providerType: "codex",
          hit: true,
          changed: true,
          changes: [{ path: "service_tier", before: null, after: "priority", changed: true }],
        },
        {
          type: "codex_service_tier_result",
          scope: "response",
          hit: true,
          requestedServiceTier: "priority",
          actualServiceTier: "default",
          billingSourcePreference: "requested",
          resolvedFrom: "requested",
          effectivePriority: true,
        },
      ])
    ).toBe(true);
  });

  test("returns false when billing follows actual non-priority tier", () => {
    expect(
      hasPriorityServiceTierSpecialSetting([
        {
          type: "codex_service_tier_result",
          scope: "response",
          hit: true,
          requestedServiceTier: "priority",
          actualServiceTier: "default",
          billingSourcePreference: "actual",
          resolvedFrom: "actual",
          effectivePriority: false,
        },
      ])
    ).toBe(false);
  });
});
