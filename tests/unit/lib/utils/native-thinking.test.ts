import { describe, expect, test } from "vitest";
import { extractNativeThinkingConfigFromRequestBody } from "@/lib/utils/native-thinking";

const protocols = ["anthropic", "gemini"] as const;

describe("native thinking request extraction", () => {
  test.each([null, undefined, [], "request", 42, true])("ignores malformed bodies: %j", (body) => {
    for (const protocol of protocols) {
      expect(extractNativeThinkingConfigFromRequestBody(body, protocol)).toBeNull();
    }
  });

  test.each(["enabled", "adaptive", "disabled"])("captures explicit Claude mode %s", (mode) => {
    expect(
      extractNativeThinkingConfigFromRequestBody({ thinking: { type: mode } }, "anthropic")
    ).toEqual({ effort: null, mode, budgetTokens: null });
  });

  test.each([0, 1, 500, 1024, 8192, 65536, Number.MAX_SAFE_INTEGER])(
    "captures the exact Claude integer budget %d without enforcing provider validation",
    (budgetTokens) => {
      expect(
        extractNativeThinkingConfigFromRequestBody(
          { thinking: { budget_tokens: budgetTokens } },
          "anthropic"
        )
      ).toEqual({ effort: null, mode: null, budgetTokens });
    }
  );

  test.each([-1, 0, 1, 8192, 65536, Number.MAX_SAFE_INTEGER])(
    "preserves the exact Gemini budget %d, including dynamic and disabled",
    (budgetTokens) => {
      expect(
        extractNativeThinkingConfigFromRequestBody(
          { generationConfig: { thinkingConfig: { thinkingBudget: budgetTokens } } },
          "gemini"
        )
      ).toEqual({ effort: null, mode: null, budgetTokens });
    }
  );

  test.each([null, undefined, false, true, "8192", "0", NaN, Infinity, -Infinity, 1.5, -2])(
    "ignores invalid budgets without coercion: %j",
    (budget) => {
      expect(
        extractNativeThinkingConfigFromRequestBody(
          { thinking: { budget_tokens: budget } },
          "anthropic"
        )
      ).toBeNull();
      expect(
        extractNativeThinkingConfigFromRequestBody(
          { generationConfig: { thinkingConfig: { thinkingBudget: budget } } },
          "gemini"
        )
      ).toBeNull();
    }
  );

  test("does not interpret Claude -1 as Gemini dynamic thinking", () => {
    expect(
      extractNativeThinkingConfigFromRequestBody({ thinking: { budget_tokens: -1 } }, "anthropic")
    ).toBeNull();
  });

  test.each(["high", "HIGH", "experimental-level", "  MAX  "])(
    "preserves raw effort/level %j",
    (effort) => {
      expect(
        extractNativeThinkingConfigFromRequestBody({ output_config: { effort } }, "anthropic")
      ).toEqual({ effort, mode: null, budgetTokens: null });
      expect(
        extractNativeThinkingConfigFromRequestBody(
          { generationConfig: { thinkingConfig: { thinkingLevel: effort } } },
          "gemini"
        )
      ).toEqual({ effort, mode: null, budgetTokens: null });
    }
  );

  test.each([null, undefined, true, 1, [], {}, "", "  "])(
    "ignores malformed effort/level %j",
    (effort) => {
      expect(
        extractNativeThinkingConfigFromRequestBody({ output_config: { effort } }, "anthropic")
      ).toBeNull();
      expect(
        extractNativeThinkingConfigFromRequestBody(
          { generationConfig: { thinkingConfig: { thinkingLevel: effort } } },
          "gemini"
        )
      ).toBeNull();
    }
  );

  test("retains valid fields independently of malformed companions", () => {
    expect(
      extractNativeThinkingConfigFromRequestBody(
        {
          thinking: { type: "unknown", budget_tokens: "8192" },
          output_config: { effort: "max" },
        },
        "anthropic"
      )
    ).toEqual({ effort: "max", mode: null, budgetTokens: null });
    expect(
      extractNativeThinkingConfigFromRequestBody(
        {
          thinking: { type: "enabled", budget_tokens: NaN },
          output_config: { effort: [] },
        },
        "anthropic"
      )
    ).toEqual({ effort: null, mode: "enabled", budgetTokens: null });
    expect(
      extractNativeThinkingConfigFromRequestBody(
        {
          generationConfig: { thinkingConfig: { thinkingLevel: false, thinkingBudget: 0 } },
        },
        "gemini"
      )
    ).toEqual({ effort: null, mode: null, budgetTokens: 0 });
  });

  test("supports independent protobuf aliases at each Gemini nesting level", () => {
    for (const generationKey of ["generationConfig", "generation_config"]) {
      for (const thinkingKey of ["thinkingConfig", "thinking_config"]) {
        for (const levelKey of ["thinkingLevel", "thinking_level"]) {
          for (const budgetKey of ["thinkingBudget", "thinking_budget"]) {
            const body = {
              [generationKey]: { [thinkingKey]: { [levelKey]: "MINIMAL", [budgetKey]: -1 } },
            };
            const expected = { effort: "MINIMAL", mode: null, budgetTokens: -1 };
            expect(extractNativeThinkingConfigFromRequestBody(body, "gemini")).toEqual(expected);
            expect(extractNativeThinkingConfigFromRequestBody({ request: body }, "gemini")).toEqual(
              expected
            );
          }
        }
      }
    }
  });

  test("prefers explicit camelCase fields over conflicting snake_case aliases", () => {
    expect(
      extractNativeThinkingConfigFromRequestBody(
        {
          generationConfig: {
            thinkingConfig: {
              thinkingLevel: "LOW",
              thinking_level: "HIGH",
              thinkingBudget: 0,
              thinking_budget: 8192,
            },
          },
          generation_config: { thinking_config: { thinking_level: "HIGH", thinking_budget: 4096 } },
        },
        "gemini"
      )
    ).toEqual({ effort: "LOW", mode: null, budgetTokens: 0 });
    expect(
      extractNativeThinkingConfigFromRequestBody(
        {
          generationConfig: { thinkingConfig: null, thinking_config: { thinking_budget: 8192 } },
        },
        "gemini"
      )
    ).toBeNull();
    expect(
      extractNativeThinkingConfigFromRequestBody(
        {
          generationConfig: {
            thinkingConfig: {
              thinkingLevel: null,
              thinking_level: "HIGH",
              thinkingBudget: null,
              thinking_budget: 8192,
            },
          },
        },
        "gemini"
      )
    ).toBeNull();
  });

  test("reads CLI configuration from the request envelope rather than outer metadata", () => {
    expect(
      extractNativeThinkingConfigFromRequestBody(
        {
          generationConfig: { thinkingConfig: { thinkingBudget: 8192 } },
          request: { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } },
        },
        "gemini"
      )
    ).toEqual({ effort: null, mode: null, budgetTokens: -1 });
  });

  test.each([
    { model: "gemini-3-pro" },
    { generationConfig: { thinkingConfig: { includeThoughts: true } } },
    { generationConfig: { thinkingConfig: { include_thoughts: false } } },
    { generationConfig: [] },
    { generationConfig: { thinkingConfig: [] } },
    { generationConfig: { thinkingConfig: "high" } },
  ])("never infers Gemini configuration from model or output preference %j", (body) => {
    expect(extractNativeThinkingConfigFromRequestBody(body, "gemini")).toBeNull();
  });

  test.each([
    { model: "claude-opus-4-6", max_tokens: 64000 },
    { thinking: [] },
    { thinking: "enabled" },
    { thinking: { type: "ENABLED" } },
    { output_config: [] },
    { output_config: "high" },
    { reasoning_effort: "high" },
  ])("never infers Claude configuration from unrelated or malformed fields %j", (body) => {
    expect(extractNativeThinkingConfigFromRequestBody(body, "anthropic")).toBeNull();
  });
});
