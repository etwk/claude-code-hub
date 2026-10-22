import { describe, expect, test } from "vitest";
import { deriveClientSafeUpstreamErrorMessage } from "@/app/v1/_lib/proxy/client-error-message";

describe("deriveClientSafeUpstreamErrorMessage", () => {
  test("extracts sanitized upstream message from JSON without secrets or origin data", () => {
    const message = deriveClientSafeUpstreamErrorMessage({
      rawText: JSON.stringify({
        error: {
          message:
            "Quota exceeded for key sk-test-1234567890abcdef at https://api.vendor.example/v1/messages request_id=req_abc123",
        },
      }),
    });

    expect(message).toContain("Quota exceeded");
    expect(message).not.toContain("sk-test");
    expect(message).not.toContain("https://");
    expect(message).not.toContain("api.vendor.example");
    expect(message).not.toContain("req_abc123");
  });

  test("extracts sanitized upstream message from SSE data", () => {
    const message = deriveClientSafeUpstreamErrorMessage({
      rawText: 'event: error\ndata: {"error":{"message":"Upstream overload"}}\n\n',
    });

    expect(message).toBe("Upstream overload");
  });

  test("rejects provider and internal details", () => {
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "Provider Anthropic returned: overload",
        providerName: "Anthropic",
      })
    ).toBeNull();
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "FAKE_200_JSON_ERROR_NON_EMPTY",
      })
    ).toBeNull();
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "HTTP 500",
      })
    ).toBeNull();
  });

  test("rejects raw JSON blob instead of returning object text", () => {
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: '{"error":{"message":"Quota exceeded"}}',
      })
    ).toBeNull();
  });

  test("rejects candidates that become empty after redaction", () => {
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "https://api.vendor.example/v1/messages request_id=req_abc123",
      })
    ).toBeNull();
  });

  test("falls back to candidateMessage when rawText is unsafe but secondary candidate is safe", () => {
    const message = deriveClientSafeUpstreamErrorMessage({
      rawText: JSON.stringify({
        error: {
          message:
            "Provider Anthropic returned: overload at gateway.internal:443 request_id=req_abc",
        },
      }),
      candidateMessage: "Quota exceeded",
      providerName: "Anthropic",
    });

    expect(message).toBe("Quota exceeded");
  });

  test("rejects host-like and internal routing labels without scheme", () => {
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "gateway.internal:443 region-us-east-1a",
      })
    ).toBeNull();
  });

  test("allows hyphenated model names while still rejecting standalone provider labels", () => {
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage:
          "The model 'claude-3-5-sonnet-20241022' does not support this parameter; try gemini-2.5-pro or deepseek-reasoner.",
        providerName: "Anthropic",
      })
    ).toBe(
      "The model 'claude-3-5-sonnet-20241022' does not support this parameter, try gemini-2.5-pro or deepseek-reasoner."
    );

    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "Claude upstream rejected the request",
      })
    ).toBeNull();
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "Request rejected by Acme-prod",
        providerName: "Acme",
      })
    ).toBeNull();
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "Connection failed at relay.xyz.",
      })
    ).toBe("Connection failed");
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessage: "Connection failed at service.xn--p1ai.",
      })
    ).toBe("Connection failed");
  });

  test("strips documentation URLs before checking forbidden provider labels", () => {
    const message = deriveClientSafeUpstreamErrorMessage({
      candidateMessage:
        "Invalid value for 'temperature': must be <= 1.0. See https://docs.anthropic.com/en/api/messages for details.",
    });

    expect(message).toContain("Invalid value for 'temperature': must be <= 1.0.");
    expect(message).not.toContain("anthropic.com");
    expect(message).not.toContain("https://");
  });

  test("falls back through candidateMessages when earlier candidates are raw JSON or internal prefixes", () => {
    expect(
      deriveClientSafeUpstreamErrorMessage({
        candidateMessages: [
          '{"detail":"Invalid temperature value"}',
          "Provider returned 400: Bad Request",
          "Invalid temperature value",
        ],
      })
    ).toBe("Invalid temperature value");
  });

  test("rejects internal concurrency, discovery, timeout, and gate messages", () => {
    for (const internalMessage of [
      "供应商并发 Session 上限已达到（10/10）",
      "Provider concurrent session limit reached (10/10)",
      "Invalid upstream discovery response",
      "MALFORMED_BUFFERED_JSON",
      "Provider failed to respond within 30000ms",
      "Stream content gate rejected upstream before first valid content (gate_error)",
    ]) {
      expect(
        deriveClientSafeUpstreamErrorMessage({
          candidateMessage: internalMessage,
        })
      ).toBeNull();
    }
  });
});
