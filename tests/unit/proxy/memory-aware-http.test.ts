// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { locales } from "@/i18n/config";
import { buildLocalCapacityResponse } from "@/lib/memory/http";

const getLocale = vi.hoisted(() => vi.fn());
vi.mock("next-intl/server", () => ({ getLocale }));

describe("local capacity response", () => {
  it.each(locales)(
    "stays English with the retry contract when the request locale is %s",
    async (locale) => {
      getLocale.mockResolvedValue(locale);
      const response = buildLocalCapacityResponse();
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.json()).toMatchObject({
        error: {
          type: "local_capacity_exceeded",
          message: "Local request capacity exhausted; retry later.",
        },
      });
    }
  );
});
