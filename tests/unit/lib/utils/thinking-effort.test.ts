import { describe, expect, test } from "vitest";
import { buildUnifiedSpecialSettings } from "@/lib/utils/special-settings";
import { extractThinkingEffortInfo } from "@/lib/utils/thinking-effort";
import type {
  NativeThinkingForwardedSpecialSetting,
  NativeThinkingSpecialSetting,
  ProviderParameterOverrideSpecialSetting,
  SpecialSetting,
  ThinkingBudgetRectifierSpecialSetting,
  ThinkingConfigValue,
  ThinkingEffortConflictRectifierSpecialSetting,
} from "@/types/special-settings";

function config(values: Partial<ThinkingConfigValue> = {}): ThinkingConfigValue {
  return { effort: null, mode: null, budgetTokens: null, ...values };
}

function native(
  values: Partial<ThinkingConfigValue>,
  protocol: "anthropic" | "gemini" = "anthropic"
): NativeThinkingSpecialSetting {
  return { type: "native_thinking", scope: "request", hit: true, protocol, config: config(values) };
}

function forwarded(
  values: Partial<ThinkingConfigValue> | null,
  protocol: "anthropic" | "gemini" = "anthropic"
): NativeThinkingForwardedSpecialSetting {
  return {
    type: "native_thinking_forwarded",
    scope: "provider",
    hit: true,
    protocol,
    providerId: 2,
    config: values === null ? null : config(values),
  };
}

function override(
  changes: ProviderParameterOverrideSpecialSetting["changes"],
  providerType: string | null = "claude"
): ProviderParameterOverrideSpecialSetting {
  return {
    type: "provider_parameter_override",
    scope: "provider",
    hit: true,
    changed: changes.some((change) => change.changed),
    providerId: 1,
    providerName: "provider",
    providerType,
    changes,
  };
}

function budgetRectifier(
  before: ThinkingBudgetRectifierSpecialSetting["before"],
  after: ThinkingBudgetRectifierSpecialSetting["after"]
): ThinkingBudgetRectifierSpecialSetting {
  return {
    type: "thinking_budget_rectifier",
    scope: "request",
    hit: true,
    providerId: 1,
    providerName: "provider",
    trigger: "budget_tokens_too_low",
    attemptNumber: 1,
    retryAttemptNumber: 2,
    before,
    after,
  };
}

function conflictRectifier(
  values: Partial<ThinkingEffortConflictRectifierSpecialSetting> = {}
): ThinkingEffortConflictRectifierSpecialSetting {
  return {
    type: "thinking_effort_conflict_rectifier",
    scope: "request",
    hit: true,
    providerId: 1,
    providerName: "provider",
    trigger: "thinking_disabled_with_reasoning_effort",
    attemptNumber: 1,
    retryAttemptNumber: 2,
    removedOutputConfigEffort: true,
    removedReasoningEffort: false,
    thinkingType: "disabled",
    effort: "high",
    ...values,
  };
}

function readPersistedThinkingInfo(settings: SpecialSetting[]) {
  return extractThinkingEffortInfo(
    JSON.parse(JSON.stringify(buildUnifiedSpecialSettings({ existing: settings })))
  );
}

describe("extractThinkingEffortInfo native configuration", () => {
  test.each([null, undefined, []])(
    "unknown audit input %j has no inferred configuration",
    (input) => {
      expect(extractThinkingEffortInfo(input)).toBeNull();
    }
  );

  test.each([
    config({ mode: "enabled", budgetTokens: 8192 }),
    config({ mode: "adaptive", effort: "max" }),
    config({ mode: "disabled", effort: "high", budgetTokens: 4096 }),
    config({ effort: "future-effort" }),
    config({ budgetTokens: 0 }),
  ])("retains every observed Claude field: %j", (value) => {
    expect(readPersistedThinkingInfo([native(value)])).toEqual({
      source: "anthropic",
      requested: value,
      effective: value,
      isOverridden: false,
    });
  });

  test.each([
    config({ effort: "HIGH" }),
    config({ effort: "  experimental-level  ", budgetTokens: 8192 }),
    config({ budgetTokens: -1 }),
    config({ budgetTokens: 0 }),
    config({ budgetTokens: 65536 }),
  ])("retains every observed Gemini field: %j", (value) => {
    expect(readPersistedThinkingInfo([native(value, "gemini")])).toEqual({
      source: "gemini",
      requested: value,
      effective: value,
      isOverridden: false,
    });
  });

  test("historical anthropic_effort remains readable", () => {
    expect(
      readPersistedThinkingInfo([
        {
          type: "anthropic_effort",
          scope: "request",
          hit: true,
          effort: "medium",
        },
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "medium" }),
      effective: config({ effort: "medium" }),
      isOverridden: false,
    });
  });

  test("a canonical request's absent effort is not filled from a duplicate legacy row", () => {
    expect(
      readPersistedThinkingInfo([
        native({ mode: "disabled" }),
        { type: "anthropic_effort", scope: "request", hit: true, effort: "high" },
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "disabled" }),
      effective: config({ mode: "disabled" }),
      isOverridden: false,
    });
  });

  test("provider-only supplied effort renders without inventing an original", () => {
    expect(
      readPersistedThinkingInfo([
        override([{ path: "output_config.effort", before: null, after: "max", changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: null,
      effective: config({ effort: "max" }),
      isOverridden: true,
    });
  });

  test("provider-only historical records reconstruct original and effective fields", () => {
    expect(
      readPersistedThinkingInfo([
        override([
          { path: "thinking.type", before: "enabled", after: "adaptive", changed: true },
          { path: "thinking.budget_tokens", before: 8192, after: null, changed: true },
          { path: "output_config.effort", before: "low", after: "max", changed: true },
        ]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "enabled", budgetTokens: 8192, effort: "low" }),
      effective: config({ mode: "adaptive", effort: "max" }),
      isOverridden: true,
    });
  });

  test("legacy effort rows can recover previously unrecorded mode and budget", () => {
    expect(
      readPersistedThinkingInfo([
        { type: "anthropic_effort", scope: "request", hit: true, effort: "low" },
        override([
          { path: "thinking.type", before: "enabled", after: "adaptive", changed: true },
          { path: "thinking.budget_tokens", before: 4096, after: null, changed: true },
          { path: "output_config.effort", before: "low", after: "max", changed: true },
        ]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "low", mode: "enabled", budgetTokens: 4096 }),
      effective: config({ effort: "max", mode: "adaptive" }),
      isOverridden: true,
    });
  });

  test("unmodified relevant fields can recover provider-only history without an override badge", () => {
    expect(
      readPersistedThinkingInfo([
        override([
          { path: "max_tokens", before: 1024, after: 2048, changed: true },
          { path: "thinking.type", before: "disabled", after: "disabled", changed: false },
          { path: "output_config.effort", before: "high", after: "high", changed: false },
        ]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "disabled", effort: "high" }),
      effective: config({ mode: "disabled", effort: "high" }),
      isOverridden: false,
    });
  });

  test("max_tokens-only overrides neither create thinking info nor mark existing info overridden", () => {
    const audit = override([{ path: "max_tokens", before: 1024, after: 64000, changed: true }]);
    expect(readPersistedThinkingInfo([audit])).toBeNull();
    expect(readPersistedThinkingInfo([native({ effort: "auto" }), audit])).toEqual({
      source: "anthropic",
      requested: config({ effort: "auto" }),
      effective: config({ effort: "auto" }),
      isOverridden: false,
    });
  });

  test("changing mode alone preserves recorded effort and budget", () => {
    expect(
      readPersistedThinkingInfo([
        native({ mode: "enabled", budgetTokens: 8192, effort: "high" }),
        override([{ path: "thinking.type", before: "enabled", after: "disabled", changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "enabled", budgetTokens: 8192, effort: "high" }),
      effective: config({ mode: "disabled", budgetTokens: 8192, effort: "high" }),
      isOverridden: true,
    });
  });

  test("native null fields remain known absent even if later historical metadata disagrees", () => {
    expect(
      readPersistedThinkingInfo([
        native({ mode: "enabled" }),
        override([{ path: "output_config.effort", before: "low", after: "high", changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "enabled" }),
      effective: config({ mode: "enabled", effort: "high" }),
      isOverridden: true,
    });
  });

  test("explicit removal of the final configured field yields effective null", () => {
    expect(
      readPersistedThinkingInfo([
        native({ effort: "high" }),
        override([{ path: "output_config.effort", before: "high", after: null, changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "high" }),
      effective: null,
      isOverridden: true,
    });
  });

  test("sequential provider overrides use the first original and last effective values", () => {
    expect(
      readPersistedThinkingInfo([
        override([{ path: "output_config.effort", before: "low", after: "high", changed: true }]),
        override([{ path: "output_config.effort", before: "high", after: "max", changed: true }]),
        override([{ path: "output_config.effort", before: "max", after: null, changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "low" }),
      effective: null,
      isOverridden: true,
    });
  });

  test("restoring the original final configuration is not displayed as an override", () => {
    expect(
      readPersistedThinkingInfo([
        native({ effort: "low" }),
        override([{ path: "output_config.effort", before: "low", after: "max", changed: true }]),
        override([{ path: "output_config.effort", before: "max", after: "low", changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "low" }),
      effective: config({ effort: "low" }),
      isOverridden: false,
    });
  });

  test("deduplication preserves A-B-A transition order and first original value", () => {
    const firstAndLast = override([
      { path: "output_config.effort", before: "low", after: "high", changed: true },
    ]);
    const middle = override([
      { path: "output_config.effort", before: "high", after: "max", changed: true },
    ]);
    expect(readPersistedThinkingInfo([firstAndLast, middle, firstAndLast])).toEqual({
      source: "anthropic",
      requested: config({ effort: "low" }),
      effective: config({ effort: "high" }),
      isOverridden: true,
    });
  });

  test("budget rectification records actual mode and budget without treating max_tokens as reasoning", () => {
    expect(
      readPersistedThinkingInfo([
        budgetRectifier(
          { maxTokens: 1024, thinkingType: "disabled", thinkingBudgetTokens: 0 },
          { maxTokens: 64000, thinkingType: "enabled", thinkingBudgetTokens: 32000 }
        ),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "disabled", budgetTokens: 0 }),
      effective: config({ mode: "enabled", budgetTokens: 32000 }),
      isOverridden: true,
    });
    expect(
      readPersistedThinkingInfo([
        budgetRectifier(
          { maxTokens: 1024, thinkingType: "enabled", thinkingBudgetTokens: 32000 },
          { maxTokens: 64000, thinkingType: "enabled", thinkingBudgetTokens: 32000 }
        ),
      ])?.isOverridden
    ).toBe(false);
  });

  test("reactive and provider audits apply in final forwarded order", () => {
    const original = config({ mode: "enabled", budgetTokens: 500, effort: "low" });
    expect(
      readPersistedThinkingInfo([
        native(original),
        override([{ path: "output_config.effort", before: "low", after: "high", changed: true }]),
        budgetRectifier(
          { maxTokens: 1000, thinkingType: "enabled", thinkingBudgetTokens: 500 },
          { maxTokens: 64000, thinkingType: "enabled", thinkingBudgetTokens: 32000 }
        ),
        override([
          { path: "thinking.type", before: "enabled", after: "disabled", changed: true },
          { path: "thinking.budget_tokens", before: 32000, after: null, changed: true },
        ]),
        conflictRectifier(),
        override([{ path: "max_tokens", before: 64000, after: 128000, changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: original,
      effective: config({ mode: "disabled" }),
      isOverridden: true,
    });
  });

  test("a later provider can supply effort again after conflict rectification", () => {
    expect(
      readPersistedThinkingInfo([
        native({ mode: "disabled", effort: "low" }),
        conflictRectifier({ effort: "low" }),
        override([{ path: "output_config.effort", before: null, after: "max", changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "disabled", effort: "low" }),
      effective: config({ mode: "disabled", effort: "max" }),
      isOverridden: true,
    });
  });

  test("conflict rectification removes only the actual output_config effort carrier", () => {
    expect(
      readPersistedThinkingInfo([
        native({ mode: "disabled", effort: "high", budgetTokens: 4096 }),
        conflictRectifier(),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "disabled", effort: "high", budgetTokens: 4096 }),
      effective: config({ mode: "disabled", budgetTokens: 4096 }),
      isOverridden: true,
    });
    expect(
      readPersistedThinkingInfo([
        native({ mode: "disabled", effort: "high" }),
        conflictRectifier({ removedOutputConfigEffort: false, removedReasoningEffort: true }),
      ])?.isOverridden
    ).toBe(false);
  });

  test("historical conflict removal can recover an effort-only request and explicit removal", () => {
    expect(readPersistedThinkingInfo([conflictRectifier({ thinkingType: null })])).toEqual({
      source: "anthropic",
      requested: config({ effort: "high" }),
      effective: null,
      isOverridden: true,
    });
  });

  test("unapplied audits and unrelated provider types cannot override native configuration", () => {
    expect(
      readPersistedThinkingInfo([
        native({ effort: "low" }),
        {
          ...override([
            { path: "output_config.effort", before: "low", after: "max", changed: true },
          ]),
          hit: false,
        },
        override(
          [{ path: "output_config.effort", before: "low", after: "high", changed: true }],
          "gemini"
        ),
        { ...conflictRectifier(), hit: false },
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "low" }),
      effective: config({ effort: "low" }),
      isOverridden: false,
    });
  });

  test("partial historical metadata is tolerated, and missing after is not explicit removal", () => {
    const settings = [
      {
        type: "provider_parameter_override",
        changes: [{ path: "output_config.effort", before: "low", after: "high" }],
      },
      { type: "provider_parameter_override" },
      { type: "thinking_budget_rectifier", hit: true, after: { thinkingBudgetTokens: 32000 } },
      {
        type: "provider_parameter_override",
        changes: [{ path: "output_config.effort", before: "high" }],
      },
    ] as SpecialSetting[];
    expect(readPersistedThinkingInfo(settings)).toEqual({
      source: "anthropic",
      requested: config({ effort: "low" }),
      effective: config({ effort: "high", budgetTokens: 32000 }),
      isOverridden: true,
    });
  });

  test("partial audits never deduplicate a later explicit removal", () => {
    const partial = {
      ...override([]),
      changes: [{ path: "output_config.effort", before: "high", changed: true }],
    } as SpecialSetting;
    expect(
      readPersistedThinkingInfo([
        native({ effort: "high" }),
        partial,
        override([{ path: "output_config.effort", before: "high", after: null, changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "high" }),
      effective: null,
      isOverridden: true,
    });

    const before = { maxTokens: 64000, thinkingType: "disabled", thinkingBudgetTokens: 8192 };
    const removal = budgetRectifier(before, {
      maxTokens: 64000,
      thinkingType: null,
      thinkingBudgetTokens: null,
    });
    const partialBudget = { ...removal, after: { maxTokens: 64000 } } as SpecialSetting;
    expect(
      readPersistedThinkingInfo([
        native({ mode: "disabled", budgetTokens: 8192 }),
        partialBudget,
        removal,
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "disabled", budgetTokens: 8192 }),
      effective: null,
      isOverridden: true,
    });
  });

  test("a wholly absent audit dimension leaves its first original evidence available", () => {
    expect(
      readPersistedThinkingInfo([
        {
          type: "thinking_budget_rectifier",
          hit: true,
          after: { thinkingBudgetTokens: 32000 },
        } as SpecialSetting,
        override([{ path: "thinking.type", before: "disabled", after: "enabled", changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "disabled" }),
      effective: config({ mode: "enabled", budgetTokens: 32000 }),
      isOverridden: true,
    });
  });

  test("missing first before stays unknown rather than becoming a later intermediate value", () => {
    expect(
      readPersistedThinkingInfo([
        {
          type: "provider_parameter_override",
          changes: [{ path: "output_config.effort", after: "high" }],
        } as SpecialSetting,
        override([{ path: "output_config.effort", before: "high", after: "max", changed: true }]),
      ])
    ).toEqual({
      source: "anthropic",
      requested: null,
      effective: config({ effort: "max" }),
      isOverridden: true,
    });
  });

  test("unknown native values never become guessed defaults", () => {
    expect(
      readPersistedThinkingInfo([
        native({
          effort: " ",
          mode: "unknown",
          budgetTokens: "8192",
        } as unknown as ThinkingConfigValue),
      ])
    ).toBeNull();
    expect(readPersistedThinkingInfo([native({ mode: "enabled", budgetTokens: NaN })])).toEqual({
      source: "anthropic",
      requested: config({ mode: "enabled" }),
      effective: config({ mode: "enabled" }),
      isOverridden: false,
    });
  });
});

describe("authoritative outgoing native configuration", () => {
  test("a losing provider's diagnostics cannot contaminate the winning outgoing configuration", () => {
    const original = config({ mode: "enabled", budgetTokens: 500, effort: "low" });
    expect(
      readPersistedThinkingInfo([
        native(original),
        override([{ path: "output_config.effort", before: "low", after: "max", changed: true }]),
        forwarded(original),
        budgetRectifier(
          { maxTokens: 1000, thinkingType: "enabled", thinkingBudgetTokens: 500 },
          { maxTokens: 64000, thinkingType: "enabled", thinkingBudgetTokens: 32000 }
        ),
        conflictRectifier({ effort: "max" }),
      ])
    ).toEqual({
      source: "anthropic",
      requested: original,
      effective: original,
      isOverridden: false,
    });
  });

  test.each([
    {
      protocol: "anthropic" as const,
      requested: config({ mode: "enabled", budgetTokens: 8192, effort: "high" }),
      effective: config({ mode: "adaptive", effort: "low" }),
    },
    {
      protocol: "anthropic" as const,
      requested: config({ mode: "adaptive", effort: "max" }),
      effective: null,
    },
    {
      protocol: "gemini" as const,
      requested: config({ budgetTokens: 8192 }),
      effective: config({ budgetTokens: 0 }),
    },
    {
      protocol: "gemini" as const,
      requested: config({ effort: "HIGH", budgetTokens: 8192 }),
      effective: config({ effort: "  experimental-level  " }),
    },
    {
      protocol: "gemini" as const,
      requested: config({ effort: "HIGH" }),
      effective: null,
    },
  ])(
    "$protocol final-filter changes and removals use the outgoing snapshot: $effective",
    (value) => {
      expect(
        readPersistedThinkingInfo([
          native(value.requested, value.protocol),
          forwarded(value.effective, value.protocol),
        ])
      ).toEqual({
        source: value.protocol,
        requested: value.requested,
        effective: value.effective,
        isOverridden: true,
      });
    }
  );

  test.each(["anthropic", "gemini"] as const)(
    "%s provider-only additions never reconstruct an original from retry diagnostics",
    (protocol) => {
      const effective = config({ effort: "  future-effort  ", budgetTokens: 8192 });
      expect(
        readPersistedThinkingInfo([
          override([{ path: "output_config.effort", before: "low", after: "high", changed: true }]),
          budgetRectifier(
            { maxTokens: 1000, thinkingType: "enabled", thinkingBudgetTokens: 500 },
            { maxTokens: 64000, thinkingType: "enabled", thinkingBudgetTokens: 32000 }
          ),
          forwarded(effective, protocol),
        ])
      ).toEqual({ source: protocol, requested: null, effective, isOverridden: true });
    }
  );

  test("canonical request absence is not filled from historical or losing provider fields", () => {
    expect(
      readPersistedThinkingInfo([
        native({ mode: "disabled" }),
        { type: "anthropic_effort", scope: "request", hit: true, effort: "high" },
        override([{ path: "thinking.budget_tokens", before: 500, after: 32000, changed: true }]),
        forwarded({ mode: "adaptive", effort: "max" }),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ mode: "disabled" }),
      effective: config({ mode: "adaptive", effort: "max" }),
      isOverridden: true,
    });
  });

  test("historical request effort remains evidence without reconstructing unknown request fields", () => {
    expect(
      readPersistedThinkingInfo([
        { type: "anthropic_effort", scope: "request", hit: true, effort: "low" },
        budgetRectifier(
          { maxTokens: 1000, thinkingType: "enabled", thinkingBudgetTokens: 500 },
          { maxTokens: 64000, thinkingType: "enabled", thinkingBudgetTokens: 32000 }
        ),
        forwarded({ effort: "high", budgetTokens: 8192 }),
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "low" }),
      effective: config({ effort: "high", budgetTokens: 8192 }),
      isOverridden: true,
    });
  });

  test.each(["anthropic", "gemini"] as const)(
    "the selected %s snapshot determines source and matching request evidence",
    (protocol) => {
      const anthropic = config({ mode: "adaptive", effort: "low" });
      const gemini = config({ effort: "HIGH", budgetTokens: -1 });
      const effective = config({ budgetTokens: 0 });
      expect(
        readPersistedThinkingInfo([
          native(anthropic),
          native(gemini, "gemini"),
          forwarded(effective, protocol),
        ])
      ).toEqual({
        source: protocol,
        requested: protocol === "anthropic" ? anthropic : gemini,
        effective,
        isOverridden: true,
      });
    }
  );

  test.each(["anthropic", "gemini"] as const)(
    "%s explicit outgoing absence never falls back to diagnostics or another native source",
    (protocol) => {
      expect(
        readPersistedThinkingInfo([
          native({ effort: "other-source" }, protocol === "anthropic" ? "gemini" : "anthropic"),
          override([{ path: "output_config.effort", before: "low", after: "max", changed: true }]),
          forwarded(null, protocol),
        ])
      ).toBeNull();
      expect(readPersistedThinkingInfo([forwarded(null, protocol)])).toBeNull();
    }
  );

  test.each([config({ effort: "max" }), null])(
    "the last outgoing snapshot wins, including explicit absence: %j",
    (effective) => {
      expect(
        readPersistedThinkingInfo([
          native({ effort: "low" }),
          forwarded({ mode: "enabled", budgetTokens: 8192 }),
          forwarded(effective),
        ])
      ).toEqual({
        source: "anthropic",
        requested: config({ effort: "low" }),
        effective,
        isOverridden: true,
      });
    }
  );

  test.each(["anthropic", "gemini"] as const)(
    "%s unknown outgoing fields remain unknown instead of falling back to request values",
    (protocol) => {
      const unknown = forwarded(
        {
          effort: " ",
          mode: "future-mode",
          budgetTokens: "8192",
        } as unknown as ThinkingConfigValue,
        protocol
      );
      expect(
        readPersistedThinkingInfo([native({ budgetTokens: 8192 }, protocol), unknown])
      ).toEqual({
        source: protocol,
        requested: config({ budgetTokens: 8192 }),
        effective: null,
        isOverridden: true,
      });
      expect(readPersistedThinkingInfo([unknown])).toBeNull();
    }
  );

  test("unapplied original evidence cannot invent a request configuration", () => {
    expect(
      readPersistedThinkingInfo([
        { ...native({ effort: "low" }), hit: false },
        { type: "anthropic_effort", scope: "request", hit: false, effort: "high" },
        forwarded({ effort: "max" }),
      ])
    ).toEqual({
      source: "anthropic",
      requested: null,
      effective: config({ effort: "max" }),
      isOverridden: true,
    });
  });

  test("unapplied and unsupported outgoing snapshots do not suppress original evidence", () => {
    expect(
      readPersistedThinkingInfo([
        native({ effort: "low" }),
        { ...forwarded(null), hit: false } as unknown as SpecialSetting,
        { ...forwarded(null), protocol: "unknown" } as unknown as SpecialSetting,
      ])
    ).toEqual({
      source: "anthropic",
      requested: config({ effort: "low" }),
      effective: config({ effort: "low" }),
      isOverridden: false,
    });
  });
});

describe("existing Codex/OpenAI precedence and values", () => {
  const codex: SpecialSetting = {
    type: "codex_reasoning_effort",
    scope: "request",
    hit: true,
    effort: "low",
  };
  const openai: SpecialSetting = {
    type: "openai_reasoning_effort",
    scope: "request",
    hit: true,
    effort: "  xhigh  ",
    source: "reasoning_effort",
  };

  test("Codex request and final provider effort remain canonicalized without native interference", () => {
    expect(
      readPersistedThinkingInfo([
        native({ effort: "HIGH" }, "gemini"),
        forwarded({ budgetTokens: 0 }, "gemini"),
        openai,
        codex,
        override(
          [{ path: "reasoning.effort", before: "low", after: "high", changed: true }],
          "codex"
        ),
        override(
          [{ path: "reasoning.effort", before: "high", after: "max", changed: true }],
          "codex"
        ),
      ])
    ).toEqual({
      source: "codex",
      requested: config({ effort: "low" }),
      effective: config({ effort: "max" }),
      isOverridden: true,
    });
  });

  test("removed Codex config remains removed and retains its source precedence", () => {
    expect(
      readPersistedThinkingInfo([
        native({ mode: "adaptive", effort: "max" }),
        forwarded(null),
        openai,
        codex,
        override(
          [{ path: "reasoning.effort", before: "low", after: null, changed: true }],
          "codex"
        ),
      ])
    ).toEqual({
      source: "codex",
      requested: config({ effort: "low" }),
      effective: null,
      isOverridden: true,
    });
  });

  test("provider-only Codex still shows a missing original", () => {
    expect(
      readPersistedThinkingInfo([
        override(
          [{ path: "reasoning.effort", before: null, after: "medium", changed: true }],
          "codex"
        ),
      ])
    ).toEqual({
      source: "codex",
      requested: null,
      effective: config({ effort: "medium" }),
      isOverridden: true,
    });
  });

  test("OpenAI retains raw effort with precedence over native providers", () => {
    expect(
      readPersistedThinkingInfo([native({ mode: "adaptive" }), forwarded(null, "gemini"), openai])
    ).toEqual({
      source: "openai",
      requested: config({ effort: "  xhigh  " }),
      effective: config({ effort: "  xhigh  " }),
      isOverridden: false,
    });
  });

  test("native Gemini has precedence over historical Anthropic rows", () => {
    expect(
      readPersistedThinkingInfo([
        { type: "anthropic_effort", scope: "request", hit: true, effort: "high" },
        native({ budgetTokens: -1 }, "gemini"),
      ])
    ).toEqual({
      source: "gemini",
      requested: config({ budgetTokens: -1 }),
      effective: config({ budgetTokens: -1 }),
      isOverridden: false,
    });
  });
});
