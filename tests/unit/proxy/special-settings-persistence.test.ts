import { expect, test, vi } from "vitest";
import type { ProxySession } from "@/app/v1/_lib/proxy/session";
import { persistSpecialSettings } from "@/app/v1/_lib/proxy/special-settings-persistence";
import { extractThinkingEffortInfo } from "@/lib/utils/thinking-effort";
import type { SpecialSetting } from "@/types/special-settings";

const storage = vi.hoisted(() => ({
  cache: vi.fn(),
  database: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/session-manager", () => ({
  SessionManager: { storeSessionSpecialSettings: storage.cache },
}));
vi.mock("@/repository/message", () => ({ updateMessageRequestDetails: storage.database }));

test("failed cache persistence still leaves a durable native configuration", async () => {
  const settings: SpecialSetting[] = [
    {
      type: "native_thinking_forwarded",
      scope: "provider",
      hit: true,
      protocol: "gemini",
      providerId: 2,
      config: { effort: null, mode: null, budgetTokens: 0 },
    },
  ];
  const session = {
    sessionId: "cache-failure",
    requestSequence: 1,
    messageContext: { id: 1 },
    getSpecialSettings: () => settings,
    shouldPersistSessionDebugArtifacts: () => true,
  } as unknown as ProxySession;
  let durableJson: string | null = null;
  storage.cache.mockRejectedValueOnce(new Error("Redis unavailable"));
  storage.database.mockImplementationOnce(async (_id, details) => {
    durableJson = JSON.stringify(details.specialSettings);
    return true;
  });

  await persistSpecialSettings(session);

  expect(extractThinkingEffortInfo(durableJson === null ? null : JSON.parse(durableJson))).toEqual({
    source: "gemini",
    requested: null,
    effective: { effort: null, mode: null, budgetTokens: 0 },
    isOverridden: true,
  });
});
