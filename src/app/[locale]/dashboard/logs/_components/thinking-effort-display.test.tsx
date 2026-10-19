import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, test, vi } from "vitest";
import dashboardMessages from "../../../../../../messages/en/dashboard.json";
import type {
  NativeThinkingSpecialSetting,
  ProviderParameterOverrideSpecialSetting,
  SpecialSetting,
  ThinkingConfigValue,
} from "@/types/special-settings";
import { ThinkingEffortDisplay } from "./thinking-effort-display";

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <div role="tooltip">{children}</div>,
}));

function nativeSetting(
  protocol: NativeThinkingSpecialSetting["protocol"],
  config: Partial<ThinkingConfigValue>
): NativeThinkingSpecialSetting {
  return {
    type: "native_thinking",
    scope: "request",
    hit: true,
    protocol,
    config: { effort: null, mode: null, budgetTokens: null, ...config },
  };
}

function providerOverride(
  changes: ProviderParameterOverrideSpecialSetting["changes"]
): ProviderParameterOverrideSpecialSetting {
  return {
    type: "provider_parameter_override",
    scope: "provider",
    providerId: 2,
    providerName: "Claude",
    providerType: "claude",
    hit: true,
    changed: true,
    changes,
  };
}

function renderThinking(specialSettings: SpecialSetting[] | null) {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{ dashboard: dashboardMessages }}>
      <ThinkingEffortDisplay specialSettings={specialSettings} />
    </NextIntlClientProvider>
  );
  const container = document.createElement("div");
  container.innerHTML = html;
  return {
    container,
    trigger: container.querySelector<HTMLButtonElement>("button"),
    requested: container.querySelector('[data-slot="thinking-config-requested"] dd'),
    effective: container.querySelector('[data-slot="thinking-config-effective"] dd'),
  };
}

describe("ThinkingEffortDisplay", () => {
  test.each([{ settings: null }, { settings: [] }, { settings: [nativeSetting("gemini", {})] }])(
    "uses a placeholder when no thinking configuration was recorded: %j",
    ({ settings }) => {
      const { container, trigger } = renderThinking(settings);
      expect(container.textContent).toBe("-");
      expect(trigger).toBeNull();
    }
  );

  test.each(["MINIMAL", "HIGH", "future-level-without-a-known-scale"])(
    "preserves the raw Gemini level %s",
    (effort) => {
      const { trigger, requested } = renderThinking([nativeSetting("gemini", { effort })]);
      expect(trigger?.textContent).toBe(effort);
      expect(requested?.textContent).toBe(`Effort: ${effort}`);
      expect(trigger?.getAttribute("aria-label")).toContain(effort);
    }
  );

  test.each([
    [-1, "Dynamic (-1)"],
    [0, "Disabled"],
    [8192, "8192 tokens"],
  ] as const)("shows Gemini budget %s without inventing a level", (budgetTokens, label) => {
    const { trigger, requested } = renderThinking([nativeSetting("gemini", { budgetTokens })]);
    expect(trigger?.textContent).toBe(label);
    expect(requested?.textContent).toContain("Budget:");
    expect(requested?.textContent).toContain(budgetTokens === 0 ? "Disabled (0)" : label);
    expect(trigger?.textContent).not.toMatch(/low|medium|high/);
  });

  test("Gemini disabling wins over a stale level while keeping all recorded values available", () => {
    const { trigger, requested } = renderThinking([
      nativeSetting("gemini", { effort: "HIGH", budgetTokens: 0 }),
    ]);
    expect(trigger?.textContent).toBe("Disabled");
    expect(requested?.textContent).toContain("HIGH");
    expect(requested?.textContent).toContain("Disabled (0)");
  });

  test.each([
    [{ mode: "enabled", budgetTokens: 4096 }, "4096 tokens"],
    [{ mode: "adaptive", effort: "high" }, "high"],
    [{ mode: "enabled" }, "Enabled"],
    [{ budgetTokens: 16384 }, "16384 tokens"],
    [{ mode: "enabled", budgetTokens: 0 }, "0 tokens"],
  ] satisfies Array<[Partial<ThinkingConfigValue>, string]>)(
    "prioritizes observed Claude effort or budget over its generic mode: %j",
    (config, label) => {
      const { trigger } = renderThinking([nativeSetting("anthropic", config)]);
      expect(trigger?.textContent).toBe(label);
    }
  );

  test("disabled Claude mode precedes stale effort and budget without hiding the raw configuration", () => {
    const { trigger, requested } = renderThinking([
      nativeSetting("anthropic", { mode: "disabled", effort: "high", budgetTokens: 4096 }),
    ]);
    expect(trigger?.textContent).toBe("Disabled");
    expect(requested?.textContent).toBe("Mode: Disabled · Effort: high · Budget: 4096 tokens");
    expect(trigger?.getAttribute("aria-label")).toContain(requested?.textContent);
  });

  test.each([
    { type: "codex_reasoning_effort", scope: "request", hit: true, effort: "xhigh" },
    {
      type: "openai_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "max",
      source: "reasoning_effort",
    },
    { type: "anthropic_effort", scope: "request", hit: true, effort: "medium" },
  ] satisfies SpecialSetting[])("retains historical effort-only values: $type", (setting) => {
    const { trigger } = renderThinking([setting]);
    expect(trigger?.textContent).toBe(setting.effort);
  });

  test("shows original and changed Codex values", () => {
    const { trigger, requested, effective } = renderThinking([
      { type: "codex_reasoning_effort", scope: "request", hit: true, effort: "low" },
      {
        ...providerOverride([
          { path: "reasoning.effort", before: "low", after: "max", changed: true },
        ]),
        providerType: "codex",
      },
    ]);
    expect(trigger?.textContent).toBe("lowmax");
    expect(requested?.textContent).toBe("Effort: low");
    expect(effective?.textContent).toBe("Effort: max");
  });

  test("renders provider-only Claude configuration instead of an empty badge", () => {
    const { trigger, requested, effective } = renderThinking([
      providerOverride([
        { path: "thinking.type", before: null, after: "adaptive", changed: true },
        { path: "output_config.effort", before: null, after: "high", changed: true },
      ]),
    ]);
    expect(trigger?.textContent).toBe("Not specifiedhigh");
    expect(requested?.textContent).toBe("Not specified");
    expect(effective?.textContent).toBe("Mode: Adaptive · Effort: high");
  });

  test("marks removed configuration instead of presenting the original as forwarded", () => {
    const { trigger, requested, effective } = renderThinking([
      nativeSetting("anthropic", { effort: "medium" }),
      providerOverride([
        { path: "output_config.effort", before: "medium", after: null, changed: true },
      ]),
    ]);
    expect(trigger?.textContent).toBe("mediumRemoved");
    expect(requested?.textContent).toBe("Effort: medium");
    expect(effective?.textContent).toBe("Removed");
    expect(trigger?.getAttribute("aria-label")).toContain("Forwarded: Removed");
  });

  test("shows a mode transition with disabled precedence in the forwarded value", () => {
    const { trigger, requested, effective } = renderThinking([
      nativeSetting("anthropic", { mode: "enabled", effort: "high", budgetTokens: 4096 }),
      providerOverride([
        { path: "thinking.type", before: "enabled", after: "disabled", changed: true },
      ]),
    ]);
    expect(trigger?.textContent).toBe("highDisabled");
    expect(requested?.textContent).toContain("Mode: Enabled");
    expect(effective?.textContent).toBe("Mode: Disabled · Effort: high · Budget: 4096 tokens");
  });

  test("exposes exact requested and forwarded budgets", () => {
    const { requested, effective } = renderThinking([
      nativeSetting("anthropic", { mode: "enabled", budgetTokens: 4096 }),
      providerOverride([
        { path: "thinking.budget_tokens", before: 4096, after: 2048, changed: true },
      ]),
    ]);
    expect(requested?.textContent).toBe("Mode: Enabled · Budget: 4096 tokens");
    expect(effective?.textContent).toBe("Mode: Enabled · Budget: 2048 tokens");
  });

  test("keeps Codex precedence over other recorded reasoning sources", () => {
    const { trigger } = renderThinking([
      nativeSetting("anthropic", { mode: "adaptive", effort: "medium" }),
      nativeSetting("gemini", { effort: "HIGH" }),
      {
        type: "openai_reasoning_effort",
        scope: "request",
        hit: true,
        effort: "max",
        source: "reasoning_effort",
      },
      { type: "codex_reasoning_effort", scope: "request", hit: true, effort: "xhigh" },
    ]);
    expect(trigger?.textContent).toBe("xhigh");
  });

  test("provides a focusable tooltip trigger with a complete accessible configuration", () => {
    const { container, trigger } = renderThinking([
      nativeSetting("gemini", { effort: "FUTURE_VERY_LONG_LEVEL", budgetTokens: -1 }),
    ]);
    expect(trigger?.type).toBe("button");
    expect(trigger?.tabIndex).toBe(0);
    expect(trigger?.getAttribute("aria-label")).toContain("FUTURE_VERY_LONG_LEVEL");
    expect(trigger?.getAttribute("aria-label")).toContain("Dynamic (-1)");
    expect(container.querySelector('[role="tooltip"]')?.textContent).toContain(
      "Budget: Dynamic (-1)"
    );
  });
});
