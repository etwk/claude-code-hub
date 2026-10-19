import { describe, expect, test } from "vitest";
import { extractAnthropicEffortFromSpecialSettings } from "@/lib/utils/anthropic-effort";
import type { SpecialSetting } from "@/types/special-settings";

describe("extractAnthropicEffortFromSpecialSettings", () => {
  test.each([null, undefined, []])("returns null for absent history %j", (settings) => {
    expect(extractAnthropicEffortFromSpecialSettings(settings)).toBeNull();
  });

  test.each(["medium", "auto", "experimental-effort"])(
    "preserves historical effort %s",
    (effort) => {
      expect(
        extractAnthropicEffortFromSpecialSettings([
          {
            type: "anthropic_effort",
            scope: "request",
            hit: true,
            effort,
          },
        ])
      ).toBe(effort);
    }
  );

  test("retains the historical whitespace normalization and skips blank values", () => {
    expect(
      extractAnthropicEffortFromSpecialSettings([
        { type: "anthropic_effort", scope: "request", hit: true, effort: " " },
        { type: "anthropic_effort", scope: "request", hit: true, effort: "  high  " },
      ])
    ).toBe("high");
  });

  test("canonical native Claude effort supplies the repository's public effort field", () => {
    const settings: SpecialSetting[] = [
      {
        type: "native_thinking",
        scope: "request",
        hit: true,
        protocol: "anthropic",
        config: { effort: "  MAX  ", mode: "adaptive", budgetTokens: null },
      },
    ];
    expect(extractAnthropicEffortFromSpecialSettings(JSON.parse(JSON.stringify(settings)))).toBe(
      "  MAX  "
    );
  });

  test("canonical absence is not overwritten by obsolete duplicated effort facts", () => {
    expect(
      extractAnthropicEffortFromSpecialSettings([
        { type: "anthropic_effort", scope: "request", hit: true, effort: "high" },
        {
          type: "native_thinking",
          scope: "request",
          hit: true,
          protocol: "anthropic",
          config: { effort: null, mode: "disabled", budgetTokens: null },
        },
      ])
    ).toBeNull();
  });

  test("Gemini levels and unapplied native audits do not populate Anthropic effort", () => {
    expect(
      extractAnthropicEffortFromSpecialSettings([
        {
          type: "native_thinking",
          scope: "request",
          hit: true,
          protocol: "gemini",
          config: { effort: "HIGH", mode: null, budgetTokens: null },
        },
        {
          type: "native_thinking",
          scope: "request",
          hit: false,
          protocol: "anthropic",
          config: { effort: "max", mode: "adaptive", budgetTokens: null },
        },
      ])
    ).toBeNull();
  });

  test("provider override audits do not rewrite the original public effort field", () => {
    expect(
      extractAnthropicEffortFromSpecialSettings([
        {
          type: "native_thinking",
          scope: "request",
          hit: true,
          protocol: "anthropic",
          config: { effort: "low", mode: "adaptive", budgetTokens: null },
        },
        {
          type: "provider_parameter_override",
          scope: "provider",
          hit: true,
          changed: true,
          providerId: 1,
          providerName: "provider",
          providerType: "claude",
          changes: [{ path: "output_config.effort", before: "low", after: "max", changed: true }],
        },
      ])
    ).toBe("low");
  });

  test("malformed historical/native effort never supplies a fabricated string", () => {
    expect(
      extractAnthropicEffortFromSpecialSettings([
        { type: "anthropic_effort", effort: 5 },
        { type: "native_thinking", protocol: "gemini", config: { effort: "high" } },
      ] as SpecialSetting[])
    ).toBeNull();
    expect(
      extractAnthropicEffortFromSpecialSettings([
        { type: "native_thinking", protocol: "anthropic" },
      ] as SpecialSetting[])
    ).toBeNull();
  });
});
