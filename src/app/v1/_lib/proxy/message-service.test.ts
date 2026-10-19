import { beforeEach, describe, expect, test, vi } from "vitest";
import { applyAnthropicProviderOverridesWithAudit } from "@/lib/anthropic/provider-overrides";
import { extractThinkingEffortInfo } from "@/lib/utils/thinking-effort";
import type { ProxySession } from "./session";

const createMessageRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@/repository/message", () => ({
  createMessageRequest: createMessageRequestMock,
}));

import { ProxyMessageService } from "./message-service";

function createSession(
  providerType: string,
  message: Record<string, unknown>,
  endpoint: string = "/v1/responses"
) {
  const specialSettings: NonNullable<ReturnType<ProxySession["getSpecialSettings"]>> = [];
  const setMessageContext = vi.fn();
  const session = {
    authState: {
      success: true,
      user: { id: 7 },
      key: { id: 8 },
      apiKey: "sk-test",
    },
    provider: {
      id: 9,
      providerType,
      costMultiplier: "1",
    },
    request: { model: "gpt-5", message },
    sessionId: "session-1",
    userAgent: "codex_cli_rs/1.0.0",
    clientIp: "127.0.0.1",
    getEndpoint: () => endpoint,
    getManagedEndpoint: () => endpoint,
    getOriginalModel: () => "gpt-5",
    setOriginalModel: vi.fn(),
    getSpecialSettings: () => (specialSettings.length > 0 ? specialSettings : null),
    addSpecialSetting: (setting: (typeof specialSettings)[number]) => specialSettings.push(setting),
    getRequestSequence: () => 1,
    getGroupCostMultiplier: () => "1",
    getMessagesLength: () => 1,
    getSessionIdentityMetadata: () => ({
      identity: "pfx:scope123:fp-deep",
      kind: "prefix_affinity",
      scopeTag: "scope123",
      fingerprint: "fp-deep",
      fingerprints: ["fp-deep", "fp-mid"],
    }),
    setMessageContext,
  } as unknown as ProxySession;

  return { session, specialSettings, setMessageContext };
}

describe("ProxyMessageService Codex reasoning effort audit", () => {
  beforeEach(() => {
    createMessageRequestMock.mockReset();
    createMessageRequestMock.mockResolvedValue({ id: 101, createdAt: new Date("2026-07-10") });
  });

  test("Codex 请求创建使用记录前保存 reasoning.effort", async () => {
    const { session, specialSettings, setMessageContext } = createSession("codex", {
      reasoning: { effort: "high" },
    });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toContainEqual({
      type: "codex_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "high",
    });
    expect(createMessageRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ special_settings: specialSettings })
    );
    expect(setMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({ id: 101, apiKey: "sk-test" })
    );
  });

  test("非 Codex 供应商不写入 Codex 思考强度审计", async () => {
    const { session, specialSettings } = createSession("openai-compatible", {
      reasoning: { effort: "high" },
    });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toEqual([]);
  });

  test("Codex 请求缺少 reasoning.effort 时不写入空审计", async () => {
    const { session, specialSettings } = createSession("codex", { reasoning: {} });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toEqual([]);
  });

  test("复用已有 Codex 思考强度审计，避免重复记录", async () => {
    const { session, specialSettings } = createSession("codex", {
      reasoning: { effort: "high" },
    });
    specialSettings.push({
      type: "codex_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "high",
    });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toHaveLength(1);
  });

  test("前缀亲和 Session identity 与原始 sessionId 一起写入请求记录", async () => {
    const { session } = createSession("codex", { reasoning: { effort: "high" } });

    await ProxyMessageService.ensureContext(session);

    expect(createMessageRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "session-1",
        session_identity: "pfx:scope123:fp-deep",
        session_identity_kind: "prefix_affinity",
        affinity_scope_tag: "scope123",
        affinity_fingerprint: "fp-deep",
        affinity_fingerprint_chain: ["fp-deep", "fp-mid"],
      })
    );
  });

  test("remote compaction v2 uses the compact management endpoint", async () => {
    const { session } = createSession("codex", { input: [{ type: "compaction_trigger" }] });
    (session as unknown as { getManagedEndpoint: () => string }).getManagedEndpoint = () =>
      "/v1/responses/compact";

    await ProxyMessageService.ensureContext(session);

    expect(createMessageRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "/v1/responses/compact" })
    );
  });

  test("openai-compatible chat/completions 顶层 reasoning_effort 保存审计", async () => {
    const { session, specialSettings } = createSession(
      "openai-compatible",
      { model: "gpt-5.5", messages: [], reasoning_effort: "high" },
      "/v1/chat/completions"
    );

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toContainEqual({
      type: "openai_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "high",
      source: "reasoning_effort",
    });
    expect(createMessageRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ special_settings: specialSettings })
    );
  });

  test("openai-compatible chat/completions 嵌套 reasoning.effort 保存审计", async () => {
    const { session, specialSettings } = createSession(
      "openai-compatible",
      { model: "gpt-5.5", messages: [], reasoning: { effort: "low" } },
      "/v1/chat/completions"
    );

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toContainEqual({
      type: "openai_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "low",
      source: "reasoning.effort",
    });
  });

  test("openai-compatible 顶层与嵌套不一致时以顶层为准", async () => {
    const { session, specialSettings } = createSession(
      "openai-compatible",
      {
        model: "gpt-5.5",
        messages: [],
        reasoning_effort: "high",
        reasoning: { effort: "low" },
      },
      "/v1/chat/completions"
    );

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toContainEqual(
      expect.objectContaining({ effort: "high", source: "reasoning_effort" })
    );
  });

  test("openai-compatible 非 chat/completions 端点不写入思考强度审计", async () => {
    const { session, specialSettings } = createSession("openai-compatible", {
      model: "gpt-5.5",
      messages: [],
      reasoning_effort: "high",
    });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toEqual([]);
  });

  test("openai-compatible chat/completions 尾斜杠变体仍保存审计", async () => {
    const { session, specialSettings } = createSession(
      "openai-compatible",
      { model: "gpt-5.5", messages: [], reasoning_effort: "high" },
      "/v1/chat/completions/"
    );

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toContainEqual({
      type: "openai_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "high",
      source: "reasoning_effort",
    });
  });

  test("openai-compatible 请求缺少 effort 时不写入空审计", async () => {
    const { session, specialSettings } = createSession(
      "openai-compatible",
      { model: "gpt-5.5", messages: [] },
      "/v1/chat/completions"
    );

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toEqual([]);
  });

  test("复用已有 openai 思考强度审计，避免重复记录", async () => {
    const { session, specialSettings } = createSession(
      "openai-compatible",
      { model: "gpt-5.5", messages: [], reasoning_effort: "high" },
      "/v1/chat/completions"
    );
    specialSettings.push({
      type: "openai_reasoning_effort",
      scope: "request",
      hit: true,
      effort: "high",
      source: "reasoning_effort",
    });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toHaveLength(1);
  });
});

describe("ProxyMessageService native reasoning audit", () => {
  beforeEach(() => {
    createMessageRequestMock.mockReset();
    createMessageRequestMock.mockResolvedValue({ id: 101, createdAt: new Date("2026-07-10") });
  });

  test.each([
    {
      provider: "claude",
      message: { thinking: { type: "enabled", budget_tokens: 8192 } },
      protocol: "anthropic",
      config: { effort: null, mode: "enabled", budgetTokens: 8192 },
    },
    {
      provider: "claude-auth",
      message: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
      protocol: "anthropic",
      config: { effort: "high", mode: "adaptive", budgetTokens: null },
    },
    {
      provider: "claude",
      message: { output_config: { effort: "custom-effort" } },
      protocol: "anthropic",
      config: { effort: "custom-effort", mode: null, budgetTokens: null },
    },
    {
      provider: "claude",
      message: {
        thinking: { type: "disabled", budget_tokens: 4096 },
        output_config: { effort: "high" },
      },
      protocol: "anthropic",
      config: { effort: "high", mode: "disabled", budgetTokens: 4096 },
    },
    {
      provider: "claude-auth",
      message: { thinking: { budget_tokens: 0 } },
      protocol: "anthropic",
      config: { effort: null, mode: null, budgetTokens: 0 },
    },
    {
      provider: "gemini",
      message: {
        generationConfig: {
          thinkingConfig: { thinkingLevel: "experimental-level", thinkingBudget: 65536 },
        },
      },
      protocol: "gemini",
      config: { effort: "experimental-level", mode: null, budgetTokens: 65536 },
    },
    {
      provider: "gemini",
      message: {
        generation_config: { thinking_config: { thinking_level: "LOW", thinking_budget: 2048 } },
      },
      protocol: "gemini",
      config: { effort: "LOW", mode: null, budgetTokens: 2048 },
    },
    {
      provider: "gemini-cli",
      message: {
        request: {
          generation_config: { thinkingConfig: { thinking_level: "MINIMAL", thinking_budget: 0 } },
        },
      },
      protocol: "gemini",
      config: { effort: "MINIMAL", mode: null, budgetTokens: 0 },
    },
    {
      provider: "gemini",
      message: { generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } } },
      protocol: "gemini",
      config: { effort: "HIGH", mode: null, budgetTokens: null },
    },
    {
      provider: "gemini",
      message: { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } },
      protocol: "gemini",
      config: { effort: null, mode: null, budgetTokens: 0 },
    },
    {
      provider: "gemini-cli",
      message: { request: { generationConfig: { thinkingConfig: { thinkingBudget: -1 } } } },
      protocol: "gemini",
      config: { effort: null, mode: null, budgetTokens: -1 },
    },
  ])(
    "persists $provider native reasoning $config",
    async ({ provider, message, protocol, config }) => {
      const { session, specialSettings } = createSession(provider, message);
      const originalMessage = JSON.stringify(message);

      await ProxyMessageService.ensureContext(session);

      expect(specialSettings).toContainEqual({
        type: "native_thinking",
        scope: "request",
        hit: true,
        protocol,
        config,
      });
      expect(specialSettings).toHaveLength(1);
      expect(JSON.stringify(session.request.message)).toBe(originalMessage);
      // Exercise the same serialized audit payload that createMessageRequest persists as JSONB.
      const persisted = JSON.parse(
        JSON.stringify(createMessageRequestMock.mock.calls[0][0].special_settings)
      );
      expect(extractThinkingEffortInfo(persisted)).toEqual({
        source: protocol,
        requested: config,
        effective: config,
        isOverridden: false,
      });
      await ProxyMessageService.ensureContext(session);
      expect(specialSettings).toHaveLength(1);
      expect(JSON.stringify(session.request.message)).toBe(originalMessage);
    }
  );

  test.each<{ provider: string; message: Record<string, unknown> }>([
    { provider: "claude", message: { model: "claude-opus-4-6" } },
    { provider: "claude", message: { thinking: null, output_config: { effort: " " } } },
    { provider: "claude-auth", message: { thinking: { type: "unknown", budget_tokens: "8192" } } },
    {
      provider: "gemini",
      message: {
        model: "gemini-3-pro",
        generationConfig: { thinkingConfig: { includeThoughts: true } },
      },
    },
    {
      provider: "gemini",
      message: {
        generationConfig: { thinkingConfig: { thinkingBudget: -2, thinkingLevel: null } },
      },
    },
    {
      provider: "gemini-cli",
      message: { request: { generationConfig: { thinkingConfig: { thinkingBudget: 1.5 } } } },
    },
    {
      provider: "openai-compatible",
      message: { thinking: { type: "enabled", budget_tokens: 8192 } },
    },
  ])(
    "does not infer native configuration for $provider from $message",
    async ({ provider, message }) => {
      const { session, specialSettings } = createSession(provider, message);
      const originalMessage = JSON.stringify(message);

      await ProxyMessageService.ensureContext(session);

      expect(specialSettings).toEqual([]);
      expect(createMessageRequestMock.mock.calls[0][0].special_settings).toBeNull();
      expect(
        extractThinkingEffortInfo(createMessageRequestMock.mock.calls[0][0].special_settings)
      ).toBeNull();
      expect(JSON.stringify(session.request.message)).toBe(originalMessage);
    }
  );

  test("repeated capture retains the original configuration after provider mutations", async () => {
    const { session, specialSettings } = createSession("claude", {
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
    await ProxyMessageService.ensureContext(session);
    session.request.message.thinking = { type: "adaptive" };
    session.request.message.output_config = { effort: "max" };

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toEqual([
      {
        type: "native_thinking",
        scope: "request",
        hit: true,
        protocol: "anthropic",
        config: { effort: null, mode: "enabled", budgetTokens: 8192 },
      },
    ]);
  });

  test("a missing original config stays missing when a provider later supplies thinking", async () => {
    const { session, specialSettings } = createSession("claude", { model: "claude-opus-4-6" });
    await ProxyMessageService.ensureContext(session);
    session.request.message.thinking = { type: "adaptive" };

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toEqual([]);
  });

  test("an existing original audit is never rewritten from a changed request", async () => {
    const { session, specialSettings } = createSession("gemini-cli", {
      request: { generationConfig: { thinkingConfig: { thinkingBudget: 8192 } } },
    });
    specialSettings.push({
      type: "native_thinking",
      scope: "request",
      hit: true,
      protocol: "gemini",
      config: { effort: null, mode: null, budgetTokens: 0 },
    });

    await ProxyMessageService.ensureContext(session);

    expect(specialSettings).toHaveLength(1);
    expect(extractThinkingEffortInfo(specialSettings)?.requested?.budgetTokens).toBe(0);
  });

  test.each([
    { original: { effort: "low", mode: "enabled", budgetTokens: 8192 } },
    { original: null },
  ])(
    "normalizes persisted original and actual provider-added config: $original",
    async ({ original }) => {
      const message: Record<string, unknown> = { model: "claude-opus-4-6", max_tokens: 64000 };
      if (original) {
        message.thinking = { type: original.mode, budget_tokens: original.budgetTokens };
        message.output_config = { effort: original.effort };
      }
      const before = JSON.stringify(message);
      let initialPersisted = "null";
      createMessageRequestMock.mockImplementationOnce(async (data) => {
        initialPersisted = JSON.stringify(data.special_settings);
        return { id: 101, createdAt: new Date("2026-07-10") };
      });
      const { session, specialSettings } = createSession("claude", message);
      await ProxyMessageService.ensureContext(session);
      expect(extractThinkingEffortInfo(JSON.parse(initialPersisted))?.requested ?? null).toEqual(
        original
      );

      const { request, audit } = applyAnthropicProviderOverridesWithAudit(
        {
          id: 9,
          providerType: "claude",
          anthropicAdaptiveThinking: {
            effort: "high",
            modelMatchMode: "all",
            models: [],
          },
        },
        message
      );
      expect(audit).not.toBeNull();
      if (audit) session.addSpecialSetting(audit);
      expect(request.thinking).toEqual({ type: "adaptive" });
      expect(JSON.stringify(session.request.message)).toBe(before);

      const persisted = JSON.parse(JSON.stringify(specialSettings));
      expect(extractThinkingEffortInfo(persisted)).toEqual({
        source: "anthropic",
        requested: original,
        effective: { effort: "high", mode: "adaptive", budgetTokens: null },
        isOverridden: true,
      });
    }
  );
});
