import { describe, expect, test } from "vitest";
import {
  extractGeminiModelFromPath,
  getGeminiModelAction,
  isNativeGeminiModelPath,
  normalizeGeminiModelName,
  rewriteGeminiModelPath,
  rewriteGeminiRequestModels,
} from "@/app/v1/_lib/gemini/model";

describe("native Gemini model identities", () => {
  test.each([
    "gemini-2.5-flash",
    "models/gemini-2.5-flash",
    "publishers/google/models/gemini-2.5-flash",
    "projects/project-a/locations/us-central1/publishers/google/models/gemini-2.5-flash",
  ])("canonicalizes %s to the same bare routing identity", (model) => {
    expect(normalizeGeminiModelName(model)).toBe("gemini-2.5-flash");
  });

  test("does not normalize unrelated slash-qualified model strings", () => {
    expect(normalizeGeminiModelName("vendor/gemini-2.5-flash")).toBe("vendor/gemini-2.5-flash");
    expect(isNativeGeminiModelPath("/v1/chat/completions")).toBe(false);
  });

  test.each(["vendor%2FModel", "ft%3Agpt%3Aorg%3Aid"])(
    "leaves OpenAI metadata resource %s outside native Gemini rules",
    (id) => {
      const pathname = `/v1/models/${id}/`;
      expect(isNativeGeminiModelPath(pathname)).toBe(false);
      expect(extractGeminiModelFromPath(pathname)).toBeNull();
      expect(rewriteGeminiModelPath(pathname, "vendor/target:revision")).toBe(pathname);
    }
  );

  test.each([
    "/v1beta/models/gemini%2D2.5%2Dflash:generateContent",
    "/v1beta/models/gemini%2d2.5-flash/",
    "/v1internal/models/gemini-2.5-flash:streamGenerateContent/",
    "/v1/publishers/google/models/gemini%2D2.5-flash:countTokens/",
    "/v1/projects/p/locations/l/publishers/google/models/gemini-2.5-flash:generateContent/",
  ])("extracts the decoded routing identity from %s", (pathname) => {
    expect(isNativeGeminiModelPath(pathname)).toBe(true);
    expect(extractGeminiModelFromPath(pathname)).toBe("gemini-2.5-flash");
    expect(rewriteGeminiModelPath(pathname, "models/gemini-2.5-flash")).toBe(pathname);
  });

  test("folds endpoint structure and actions without changing model identity case", () => {
    const pathname = "/V1BETA/MODELS/Gemini%2DPro:COUNTTOKENS/";
    expect(extractGeminiModelFromPath(pathname)).toBe("Gemini-Pro");
    expect(getGeminiModelAction(pathname)).toBe("counttokens");
    expect(rewriteGeminiModelPath(pathname, "Gemini-Flash")).toBe(
      "/V1BETA/MODELS/Gemini-Flash:COUNTTOKENS/"
    );
  });

  test.each([
    "gemini%",
    "gemini%2",
    "gemini%GG",
    "gemini%C0%AF",
    "gemini%2Fpro",
    "gemini%3Apro",
    "gemini%20pro",
  ])(
    "rejects malformed or non-segment URL identity %s instead of returning a fallback",
    (segment) => {
      const pathname = `/v1beta/models/${segment}:generateContent/`;
      expect(isNativeGeminiModelPath(pathname)).toBe(true);
      expect(() => extractGeminiModelFromPath(pathname)).toThrow(URIError);
      expect(() => rewriteGeminiModelPath(pathname, "gemini-2.5-flash")).toThrow(URIError);
    }
  );

  test("decodes URL segments once but never percent-decodes JSON resource identities", () => {
    expect(extractGeminiModelFromPath("/v1beta/models/gemini%252Dpro:generateContent")).toBe(
      "gemini%2Dpro"
    );
    expect(normalizeGeminiModelName("models/gemini%2Dpro")).toBe("gemini%2Dpro");
    expect(normalizeGeminiModelName("vendor/gemini%2Dpro")).toBe("vendor/gemini%2Dpro");
    const message = { model: "models/gemini%2Dpro" };
    expect(
      rewriteGeminiRequestModels(message, "gemini%2Dpro", "/v1beta/models/gemini%252Dpro")
    ).toBe(false);
    expect(message.model).toBe("models/gemini%2Dpro");
  });

  test("encodes redirected IDs without escaping the model segment or double-encoding on retry", () => {
    const pathname = "/v1/publishers/google/models/gemini%2Da:generateContent/";
    const target = "gemini%2Db?revision#fragment";
    const rewritten = rewriteGeminiModelPath(pathname, target);
    expect(rewritten).toBe(
      "/v1/publishers/google/models/gemini%252Db%3Frevision%23fragment:generateContent/"
    );
    expect(extractGeminiModelFromPath(rewritten)).toBe(target);
    expect(rewriteGeminiModelPath(rewritten, target)).toBe(rewritten);
  });

  test.each(["other/model", "other:generateContent", "other model", ".", ".."])(
    "rejects redirect targets that cannot be model segments: %s",
    (target) => {
      expect(() => rewriteGeminiModelPath("/v1beta/models/gemini-a", target)).toThrow(URIError);
    }
  );

  test("ignores non-native paths for extraction and rewriting", () => {
    expect(extractGeminiModelFromPath("/v1/chat/completions")).toBeNull();
    expect(getGeminiModelAction("/v1/chat/completions")).toBeNull();
    expect(rewriteGeminiModelPath("/v1/chat/completions", "vendor/model%2D1")).toBe(
      "/v1/chat/completions"
    );
  });

  test("retains resource prefixes and leaves an unchanged native payload intact", () => {
    const message = { model: "models/gemini-2.5-flash", contents: [{ parts: [{ text: "hi" }] }] };
    const contents = message.contents;
    expect(
      rewriteGeminiRequestModels(
        message,
        "gemini-2.5-flash",
        "/v1beta/models/gemini-2.5-flash:generateContent"
      )
    ).toBe(false);
    expect(message.contents).toBe(contents);
    expect(message.model).toBe("models/gemini-2.5-flash");
    expect(
      rewriteGeminiRequestModels(
        message,
        "models/gemini-2.5-pro",
        "/v1beta/models/gemini-2.5-flash:generateContent"
      )
    ).toBe(true);
    expect(message.model).toBe("models/gemini-2.5-pro");
  });

  test.each(["", "/"])("rewrites batch embedding models with trailing suffix %j", (suffix) => {
    const message = {
      requests: [
        {
          model: "models/embedding-a",
          content: { model: "user-content", parts: [{ text: "hi" }] },
        },
        { model: "embedding-a", content: { parts: [] } },
        { content: { parts: [] } },
      ],
    };
    expect(
      rewriteGeminiRequestModels(
        message,
        "embedding-b",
        `/v1beta/models/embedding-a:batchEmbedContents${suffix}`
      )
    ).toBe(true);
    expect(message).not.toHaveProperty("model");
    expect(message.requests[0].model).toBe("models/embedding-b");
    expect(message.requests[1].model).toBe("embedding-b");
    expect(message.requests[2]).not.toHaveProperty("model");
    expect(message.requests[0].content.model).toBe("user-content");
  });

  test.each(["", "/"])("rewrites countTokens nested models with trailing suffix %j", (suffix) => {
    const message = {
      generateContentRequest: {
        model: "projects/p/locations/l/publishers/google/models/gemini-a",
        contents: [{ model: "user-content", parts: [{ text: "hi" }] }],
      },
    };
    expect(
      rewriteGeminiRequestModels(message, "gemini-b", `/v1/models/gemini-a:countTokens${suffix}`)
    ).toBe(true);
    expect(message.generateContentRequest.model).toBe(
      "projects/p/locations/l/publishers/google/models/gemini-b"
    );
    expect(message.generateContentRequest.contents[0].model).toBe("user-content");
    expect(message).not.toHaveProperty("model");
  });

  test("does not add an absent countTokens nested model or rewrite non-native payloads", () => {
    const message = { model: "vendor/a", generateContentRequest: { contents: [] } };
    expect(rewriteGeminiRequestModels(message, "vendor/b", "/v1/chat/completions")).toBe(false);
    expect(message.model).toBe("vendor/a");
    expect(
      rewriteGeminiRequestModels(message, "gemini-b", "/v1beta/models/gemini-a:countTokens")
    ).toBe(true);
    expect(message.generateContentRequest).not.toHaveProperty("model");
  });

  test("rewrites publisher paths using a bare target and preserves literal dollar sequences", () => {
    expect(
      rewriteGeminiModelPath("/v1/publishers/google/models/gemini-a:countTokens", "models/a$&b$1")
    ).toBe("/v1/publishers/google/models/a$&b$1:countTokens");
    expect(rewriteGeminiModelPath("/v1beta/models/gemini-a", "gemini-a")).toBe(
      "/v1beta/models/gemini-a"
    );
  });
});
