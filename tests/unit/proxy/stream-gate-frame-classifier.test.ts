import { describe, expect, it } from "vitest";
import {
  classifyFrame,
  isCleanResponsesCompletion,
  isRequestEchoFrame,
  mapProviderTypeToFamily,
} from "@/app/v1/_lib/proxy/stream-gate/frame-classifier";

describe("mapProviderTypeToFamily", () => {
  it("maps provider types to protocol families", () => {
    expect(mapProviderTypeToFamily("claude")).toBe("anthropic");
    expect(mapProviderTypeToFamily("claude-auth")).toBe("anthropic");
    expect(mapProviderTypeToFamily("codex")).toBe("openai-responses");
    expect(mapProviderTypeToFamily("openai-compatible")).toBe("openai-chat");
    expect(mapProviderTypeToFamily("gemini")).toBe("gemini");
    expect(mapProviderTypeToFamily("gemini-cli")).toBe("gemini");
    expect(mapProviderTypeToFamily("unknown-type")).toBeNull();
    expect(mapProviderTypeToFamily(null)).toBeNull();
  });
});

describe("classifyFrame: anthropic", () => {
  it("content: text delta", () => {
    expect(
      classifyFrame(
        "anthropic",
        "content_block_delta",
        '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}'
      )
    ).toBe("content");
  });

  it("content: embedded type without SSE event name", () => {
    expect(
      classifyFrame("anthropic", null, '{"type":"content_block_delta","delta":{"text":"hi"}}')
    ).toBe("content");
  });

  it("content: thinking / partial_json / signature deltas", () => {
    expect(
      classifyFrame("anthropic", null, '{"type":"content_block_delta","delta":{"thinking":"..."}}')
    ).toBe("content");
    expect(
      classifyFrame(
        "anthropic",
        null,
        '{"type":"content_block_delta","delta":{"partial_json":"{\\"a\\""}}'
      )
    ).toBe("content");
    expect(
      classifyFrame("anthropic", null, '{"type":"content_block_delta","delta":{"signature":"sig"}}')
    ).toBe("content");
  });

  it("neutral: empty text delta", () => {
    expect(
      classifyFrame("anthropic", null, '{"type":"content_block_delta","delta":{"text":""}}')
    ).toBe("neutral");
  });

  it("neutral: content_block_start carrying only tool metadata", () => {
    expect(
      classifyFrame(
        "anthropic",
        "content_block_start",
        '{"type":"content_block_start","content_block":{"type":"tool_use","id":"t1","name":"f"}}'
      )
    ).toBe("neutral");
  });

  it("neutral: content_block_start for empty text block", () => {
    expect(
      classifyFrame(
        "anthropic",
        "content_block_start",
        '{"type":"content_block_start","content_block":{"type":"text","text":""}}'
      )
    ).toBe("neutral");
  });

  it("requires entity payload before structured content_block_start commits", () => {
    expect(
      classifyFrame(
        "anthropic",
        "content_block_start",
        '{"type":"content_block_start","content_block":{"type":"redacted_thinking","data":""}}'
      )
    ).toBe("neutral");
    expect(
      classifyFrame(
        "anthropic",
        "content_block_start",
        '{"type":"content_block_start","content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[]}}'
      )
    ).toBe("neutral");
    expect(
      classifyFrame(
        "anthropic",
        "content_block_start",
        '{"type":"content_block_start","content_block":{"type":"redacted_thinking","data":"opaque"}}'
      )
    ).toBe("content");
    expect(
      classifyFrame(
        "anthropic",
        "content_block_start",
        '{"type":"content_block_start","content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","url":"https://example.com"}]}}'
      )
    ).toBe("content");
  });

  it.each([
    ["content_block_start", "content_block", "compaction", "content"],
    ["content_block_start", "content_block", "compaction", "encrypted_content"],
    ["content_block_delta", "delta", "compaction_delta", "content"],
    ["content_block_delta", "delta", "compaction_delta", "encrypted_content"],
  ])("content: %s with %s type=%s field=%s", (event, path, type, field) => {
    const data = JSON.stringify({
      type: event,
      index: 0,
      [path]: { type, [field]: "summary or opaque state" },
    });
    expect(classifyFrame("anthropic", event, data)).toBe("content");
    expect(classifyFrame("anthropic", null, data)).toBe("content");
  });

  it.each([
    ["content_block_start", "content_block", "compaction"],
    ["content_block_delta", "delta", "compaction_delta"],
  ])("neutral: %s with empty compaction payload", (event, path, type) => {
    for (const value of [undefined, null, ""]) {
      const data = JSON.stringify({
        type: event,
        [path]: {
          type,
          content: value,
          encrypted_content: value,
          ...(path === "content_block" ? { signature: "signature-only" } : {}),
        },
      });
      expect(classifyFrame("anthropic", event, data)).toBe("neutral");
    }
  });

  it("neutral: message_start / ping / message_delta bookkeeping", () => {
    expect(
      classifyFrame("anthropic", "message_start", '{"type":"message_start","message":{"id":"m"}}')
    ).toBe("neutral");
    expect(classifyFrame("anthropic", "ping", '{"type":"ping"}')).toBe("neutral");
    expect(
      classifyFrame(
        "anthropic",
        "message_delta",
        '{"type":"message_delta","usage":{"output_tokens":5}}'
      )
    ).toBe("neutral");
  });

  it("content: message_delta 请求级 refusal 是可交付结果（#1491）", () => {
    const refusal =
      '{"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"reasoning_extraction"}},"usage":{"output_tokens":0}}';
    expect(classifyFrame("anthropic", "message_delta", refusal)).toBe("content");
    // 无 event 行时按 data.type 识别
    expect(classifyFrame("anthropic", null, refusal)).toBe("content");
    // 其他 stop_reason 仍只是 bookkeeping，不能让空流借道提交
    for (const stopReason of ['"end_turn"', '"max_tokens"', '"stop_sequence"', "null"]) {
      const data = `{"type":"message_delta","delta":{"stop_reason":${stopReason}}}`;
      expect(classifyFrame("anthropic", "message_delta", data)).toBe("neutral");
    }
    // refusal 字段只在 message_delta 上有语义
    expect(
      classifyFrame(
        "anthropic",
        "content_block_delta",
        '{"type":"content_block_delta","delta":{"stop_reason":"refusal"}}'
      )
    ).toBe("neutral");
    // 同帧携带 error 时错误优先，不能被当作拒绝放行
    expect(
      classifyFrame(
        "anthropic",
        "message_delta",
        '{"type":"message_delta","delta":{"stop_reason":"refusal"},"error":{"message":"boom"}}'
      )
    ).toBe("error");
  });

  it("content: omitted-thinking progress delta with numeric estimated_tokens (#12)", () => {
    const delta = (estimated: number | null) =>
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "", estimated_tokens: estimated },
      });
    expect(classifyFrame("anthropic", "content_block_delta", delta(50))).toBe("content");
    expect(classifyFrame("anthropic", null, delta(0))).toBe("content");
    // 进度结束时的 null 占位帧不携带任何可交付信号
    expect(classifyFrame("anthropic", "content_block_delta", delta(null))).toBe("neutral");
  });

  it("tool-use content_block_start commits only with an inline non-empty input (#12)", () => {
    for (const type of ["tool_use", "server_tool_use", "mcp_tool_use"]) {
      const start = (input?: unknown) =>
        JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type, id: "toolu_1", name: "lookup", ...(input ? { input } : {}) },
        });
      expect(classifyFrame("anthropic", "content_block_start", start()), type).toBe("neutral");
      expect(classifyFrame("anthropic", "content_block_start", start({})), type).toBe("neutral");
      expect(classifyFrame("anthropic", "content_block_start", start({ query: "ok" })), type).toBe(
        "content"
      );
    }
    // input 只对工具块有语义
    expect(
      classifyFrame(
        "anthropic",
        "content_block_start",
        '{"type":"content_block_start","content_block":{"type":"text","text":"","input":{"a":1}}}'
      )
    ).toBe("neutral");
  });

  it("content: message_delta stop_reason tool_use / pause_turn completes a parameterless tool turn (#12)", () => {
    for (const stopReason of ["tool_use", "pause_turn"]) {
      const data = `{"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null},"usage":{"output_tokens":35}}`;
      expect(classifyFrame("anthropic", "message_delta", data)).toBe("content");
      expect(classifyFrame("anthropic", null, data)).toBe("content");
      expect(
        classifyFrame(
          "anthropic",
          "message_delta",
          `{"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"error":{"message":"boom"}}`
        )
      ).toBe("error");
    }
    // compaction 结束本身不证明有 payload，仍由 compaction 块决定
    expect(
      classifyFrame(
        "anthropic",
        "message_delta",
        '{"type":"message_delta","delta":{"stop_reason":"compaction"}}'
      )
    ).toBe("neutral");
  });

  it("error: error event and fake-200 error envelope", () => {
    expect(
      classifyFrame(
        "anthropic",
        "error",
        '{"type":"error","error":{"type":"overloaded_error","message":"x"}}'
      )
    ).toBe("error");
    expect(classifyFrame("anthropic", null, '{"error":{"message":"boom"}}')).toBe("error");
  });

  it("error takes precedence over content in the same frame", () => {
    expect(
      classifyFrame(
        "anthropic",
        "content_block_delta",
        '{"type":"content_block_delta","delta":{"text":"hi"},"error":{"message":"x"}}'
      )
    ).toBe("error");
  });

  it("terminal: message_stop", () => {
    expect(classifyFrame("anthropic", "message_stop", '{"type":"message_stop"}')).toBe("terminal");
  });

  it("malformed: broken or non-object JSON", () => {
    expect(classifyFrame("anthropic", null, '{"type":')).toBe("malformed");
    expect(classifyFrame("anthropic", null, "plain text")).toBe("malformed");
    expect(classifyFrame("anthropic", null, '"just a string"')).toBe("malformed");
  });

  it("neutral: unknown future event", () => {
    expect(classifyFrame("anthropic", "future_event", '{"type":"future_event"}')).toBe("neutral");
  });
});

describe("classifyFrame: openai-chat", () => {
  it("content: delta content / reasoning / tool arguments / refusal / audio", () => {
    expect(classifyFrame("openai-chat", null, '{"choices":[{"delta":{"content":"hi"}}]}')).toBe(
      "content"
    );
    expect(
      classifyFrame(
        "openai-chat",
        null,
        '{"choices":[{"delta":{"reasoning_content":"reasoning step"}}]}'
      )
    ).toBe("content");
    expect(
      classifyFrame(
        "openai-chat",
        null,
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{}"}}]}}]}'
      )
    ).toBe("content");
    expect(classifyFrame("openai-chat", null, '{"choices":[{"delta":{"refusal":"no"}}]}')).toBe(
      "content"
    );
    expect(
      classifyFrame("openai-chat", null, '{"choices":[{"delta":{"audio":{"data":"b64"}}}]}')
    ).toBe("content");
  });

  it("neutral: role-only first chunk / finish_reason-only / usage-only", () => {
    expect(classifyFrame("openai-chat", null, '{"choices":[{"delta":{"role":"assistant"}}]}')).toBe(
      "neutral"
    );
    expect(
      classifyFrame("openai-chat", null, '{"choices":[{"delta":{},"finish_reason":"stop"}]}')
    ).toBe("neutral");
    expect(classifyFrame("openai-chat", null, '{"choices":[],"usage":{"total_tokens":10}}')).toBe(
      "neutral"
    );
    expect(
      classifyFrame(
        "openai-chat",
        null,
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":""}}]}}]}'
      )
    ).toBe("neutral");
  });

  it("neutral: empty string content or reasoning delta", () => {
    expect(classifyFrame("openai-chat", null, '{"choices":[{"delta":{"content":""}}]}')).toBe(
      "neutral"
    );
    expect(
      classifyFrame("openai-chat", null, '{"choices":[{"delta":{"reasoning_content":""}}]}')
    ).toBe("neutral");
  });

  it("content: finish_reason tool_calls / function_call completes a parameterless call", () => {
    for (const finishReason of ["tool_calls", "function_call"]) {
      expect(
        classifyFrame(
          "openai-chat",
          null,
          `{"choices":[{"index":0,"delta":{},"finish_reason":"${finishReason}"}]}`
        )
      ).toBe("content");
    }
    for (const finishReason of ['"length"', '"content_filter"', "null"]) {
      expect(
        classifyFrame(
          "openai-chat",
          null,
          `{"choices":[{"index":0,"delta":{},"finish_reason":${finishReason}}]}`
        )
      ).toBe("neutral");
    }
  });

  it("error: in-stream error payload", () => {
    expect(classifyFrame("openai-chat", null, '{"error":{"message":"rate limited"}}')).toBe(
      "error"
    );
  });

  it("terminal: [DONE] sentinel", () => {
    expect(classifyFrame("openai-chat", null, "[DONE]")).toBe("terminal");
    expect(classifyFrame("openai-chat", null, "  [DONE]  ")).toBe("terminal");
  });

  it("malformed: non-JSON that is not the sentinel", () => {
    expect(classifyFrame("openai-chat", null, "DONE")).toBe("malformed");
  });
});

describe("classifyFrame: openai-responses", () => {
  it("content: output_text delta via SSE event name", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_text.delta",
        '{"type":"response.output_text.delta","delta":"hi"}'
      )
    ).toBe("content");
  });

  it("content: embedded type without event name", () => {
    expect(
      classifyFrame("openai-responses", null, '{"type":"response.output_text.delta","delta":"hi"}')
    ).toBe("content");
  });

  it("content: reasoning delta / function_call arguments done / partial image", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.reasoning_text.delta",
        '{"type":"response.reasoning_text.delta","delta":"think"}'
      )
    ).toBe("content");
    expect(
      classifyFrame(
        "openai-responses",
        "response.function_call_arguments.done",
        '{"type":"response.function_call_arguments.done","arguments":"{}"}'
      )
    ).toBe("content");
    expect(
      classifyFrame(
        "openai-responses",
        "response.image_generation_call.partial_image",
        '{"type":"response.image_generation_call.partial_image","partial_image_b64":"abc"}'
      )
    ).toBe("content");
  });

  it("content: custom tool-call input delta and done payloads", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.custom_tool_call_input.delta",
        '{"type":"response.custom_tool_call_input.delta","delta":"{\\"path\\":\\"README.md\\"}"}'
      )
    ).toBe("content");
    expect(
      classifyFrame(
        "openai-responses",
        "response.custom_tool_call_input.done",
        '{"type":"response.custom_tool_call_input.done","input":"{\\"path\\":\\"README.md\\"}"}'
      )
    ).toBe("content");
  });

  it("neutral: empty custom tool-call input delta and done payloads", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.custom_tool_call_input.delta",
        '{"type":"response.custom_tool_call_input.delta","delta":""}'
      )
    ).toBe("neutral");
    expect(
      classifyFrame(
        "openai-responses",
        "response.custom_tool_call_input.done",
        '{"type":"response.custom_tool_call_input.done","input":""}'
      )
    ).toBe("neutral");
  });

  it("neutral: output_item.added carrying only tool metadata", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.added",
        '{"type":"response.output_item.added","item":{"type":"function_call","name":"get_x"}}'
      )
    ).toBe("neutral");
  });

  it("content: output_item tool payload with complete arguments", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.done",
        '{"type":"response.output_item.done","item":{"type":"function_call","name":"get_x","arguments":"{}"}}'
      )
    ).toBe("content");
  });

  it.each([
    ["function_call", { name: "get_time", call_id: "call_1", arguments: "" }],
    ["mcp_call", { name: "ping", server_label: "srv", arguments: "" }],
    ["custom_tool_call", { name: "noop", call_id: "call_2", input: "" }],
  ])("content: completed parameterless %s item; added stays neutral", (type, fields) => {
    const frame = (event: string, item: Record<string, unknown>) =>
      JSON.stringify({ type: event, output_index: 0, item: { id: "item_1", type, ...item } });
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.done",
        frame("response.output_item.done", fields)
      )
    ).toBe("content");
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.added",
        frame("response.output_item.added", fields)
      )
    ).toBe("neutral");
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.done",
        frame("response.output_item.done", { ...fields, name: "" })
      )
    ).toBe("neutral");
  });

  it.each([
    ["image_generation_call", "result", "base64-png", null],
    ["file_search_call", "results", [{ file_id: "file_1", text: "hit" }], []],
    // 省略 name，单独验证 output 字段
    ["mcp_call", "output", "tool output", ""],
    ["code_interpreter_call", "outputs", [{ type: "logs", logs: "ok" }], []],
  ])("output_item.done %s commits on non-empty %s", (type, field, value, empty) => {
    for (const [payload, verdict] of [
      [value, "content"],
      [empty, "neutral"],
    ] as const) {
      const data = JSON.stringify({
        type: "response.output_item.done",
        item: { id: "item_1", type, status: "completed", [field]: payload },
      });
      expect(classifyFrame("openai-responses", "response.output_item.done", data)).toBe(verdict);
    }
  });

  it("content: compaction output item with opaque encrypted content", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.done",
        '{"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"opaque-state"}}'
      )
    ).toBe("content");
  });

  it("content: response.completed carrying compaction output with opaque state", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.completed",
        '{"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"opaque-state"}]}}'
      )
    ).toBe("content");
  });

  it("terminal: response.completed without a non-empty compaction output", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.completed",
        '{"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":""}]}}'
      )
    ).toBe("terminal");
    expect(
      classifyFrame(
        "openai-responses",
        "response.completed",
        '{"type":"response.completed","response":{"status":"completed","output":[{"type":"reasoning","encrypted_content":"opaque-state"}]}}'
      )
    ).toBe("terminal");
    expect(
      classifyFrame(
        "openai-responses",
        "response.completed",
        '{"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":""},{"type":"reasoning","encrypted_content":"opaque-state"}]}}'
      )
    ).toBe("terminal");
  });

  it("rejects non-string compaction encrypted content", () => {
    for (const encryptedContent of [true, 42, { opaque: "state" }]) {
      expect(
        classifyFrame(
          "openai-responses",
          "response.output_item.done",
          JSON.stringify({
            type: "response.output_item.done",
            item: { type: "compaction", encrypted_content: encryptedContent },
          })
        )
      ).toBe("neutral");
      expect(
        classifyFrame(
          "openai-responses",
          "response.completed",
          JSON.stringify({
            type: "response.completed",
            response: {
              status: "completed",
              output: [{ type: "compaction", encrypted_content: encryptedContent }],
            },
          })
        )
      ).toBe("terminal");
    }
  });

  it("neutral: empty or non-compaction encrypted output item", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.done",
        '{"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":""}}'
      )
    ).toBe("neutral");
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.done",
        '{"type":"response.output_item.done","item":{"type":"reasoning","encrypted_content":"opaque-state"}}'
      )
    ).toBe("neutral");
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.added",
        '{"type":"response.output_item.added","item":{"type":"compaction","encrypted_content":"opaque-state"}}'
      )
    ).toBe("neutral");
  });

  it("neutral: output_item.added without item.name (message item)", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.output_item.added",
        '{"type":"response.output_item.added","item":{"type":"message"}}'
      )
    ).toBe("neutral");
  });

  it("neutral: response.created with error:null does not hit error rule", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.created",
        '{"type":"response.created","response":{"id":"r","error":null}}'
      )
    ).toBe("neutral");
  });

  it("neutral: sub-tool failures are recoverable", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.mcp_call.failed",
        '{"type":"response.mcp_call.failed"}'
      )
    ).toBe("neutral");
  });

  it("error: top-level error event / response.failed / populated response.error", () => {
    expect(
      classifyFrame("openai-responses", "error", '{"type":"error","code":"x","message":"m"}')
    ).toBe("error");
    expect(
      classifyFrame(
        "openai-responses",
        "response.error",
        '{"type":"response.error","code":"stream_read_error","message":"stream_read_error"}'
      )
    ).toBe("error");
    expect(
      classifyFrame(
        "openai-responses",
        "response.failed",
        '{"type":"response.failed","response":{"error":{"message":"m"}}}'
      )
    ).toBe("error");
    expect(
      classifyFrame(
        "openai-responses",
        "response.in_progress",
        '{"type":"response.in_progress","response":{"error":{"message":"m"}}}'
      )
    ).toBe("error");
  });

  it("terminal: response.completed / response.incomplete", () => {
    expect(
      classifyFrame(
        "openai-responses",
        "response.completed",
        '{"type":"response.completed","response":{"output":[],"error":null}}'
      )
    ).toBe("terminal");
    expect(
      classifyFrame(
        "openai-responses",
        "response.incomplete",
        '{"type":"response.incomplete","response":{"error":null}}'
      )
    ).toBe("terminal");
  });
});

describe("classifyFrame: gemini", () => {
  it("content: text / functionCall / inlineData parts", () => {
    expect(
      classifyFrame(
        "gemini",
        null,
        '{"candidates":[{"content":{"parts":[{"text":"hi"}],"role":"model"}}]}'
      )
    ).toBe("content");
    expect(
      classifyFrame(
        "gemini",
        null,
        '{"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{}}}]}}]}'
      )
    ).toBe("content");
    expect(
      classifyFrame(
        "gemini",
        null,
        '{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"b64"}}]}}]}'
      )
    ).toBe("content");
  });

  it("neutral: usageMetadata-only chunk", () => {
    expect(
      classifyFrame("gemini", null, '{"usageMetadata":{"totalTokenCount":10},"modelVersion":"g"}')
    ).toBe("neutral");
  });

  it("neutral: empty parts / empty text", () => {
    expect(classifyFrame("gemini", null, '{"candidates":[{"content":{"parts":[]}}]}')).toBe(
      "neutral"
    );
    expect(
      classifyFrame("gemini", null, '{"candidates":[{"content":{"parts":[{"text":""}]}}]}')
    ).toBe("neutral");
  });

  it("content: thought signature carries opaque thinking even with empty text", () => {
    const chunk = (thoughtSignature: string) => ({
      candidates: [{ content: { parts: [{ thought: true, text: "", thoughtSignature }] } }],
    });
    expect(classifyFrame("gemini", null, JSON.stringify(chunk("sig")))).toBe("content");
    expect(classifyFrame("gemini", null, JSON.stringify({ response: chunk("sig") }))).toBe(
      "content"
    );
    expect(classifyFrame("gemini", null, JSON.stringify(chunk("")))).toBe("neutral");
  });

  it("error: error chunk / promptFeedback.blockReason / abnormal finishReason", () => {
    expect(
      classifyFrame("gemini", null, '{"error":{"code":500,"message":"x","status":"INTERNAL"}}')
    ).toBe("error");
    expect(classifyFrame("gemini", null, '{"promptFeedback":{"blockReason":"SAFETY"}}')).toBe(
      "error"
    );
    expect(classifyFrame("gemini", null, '{"candidates":[{"finishReason":"SAFETY"}]}')).toBe(
      "error"
    );
    expect(
      classifyFrame("gemini", null, '{"candidates":[{"finishReason":"MALFORMED_FUNCTION_CALL"}]}')
    ).toBe("error");
  });

  it("error precedence: SAFETY finishReason beats content in same chunk", () => {
    expect(
      classifyFrame(
        "gemini",
        null,
        '{"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"SAFETY"}]}'
      )
    ).toBe("error");
  });

  it("error precedence: wrapper error beats response content", () => {
    expect(
      classifyFrame(
        "gemini",
        null,
        '{"error":{"message":"failed"},"response":{"candidates":[{"content":{"parts":[{"text":"must not commit"}]}}]}}'
      )
    ).toBe("error");
  });

  it("content precedence: normal STOP with text is content, not terminal", () => {
    expect(
      classifyFrame(
        "gemini",
        null,
        '{"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}'
      )
    ).toBe("content");
  });

  it("terminal: STOP / MAX_TOKENS finishReason without content", () => {
    expect(classifyFrame("gemini", null, '{"candidates":[{"finishReason":"STOP"}]}')).toBe(
      "terminal"
    );
    expect(classifyFrame("gemini", null, '{"candidates":[{"finishReason":"MAX_TOKENS"}]}')).toBe(
      "terminal"
    );
  });
});

describe("classifyFrame: shared edge cases", () => {
  it("neutral: empty / whitespace-only data", () => {
    expect(classifyFrame("anthropic", null, "")).toBe("neutral");
    expect(classifyFrame("openai-chat", null, "   ")).toBe("neutral");
  });

  it("malformed: truncated JSON in every family", () => {
    for (const family of ["anthropic", "openai-chat", "openai-responses", "gemini"] as const) {
      expect(classifyFrame(family, null, '{"cut')).toBe("malformed");
    }
  });

  it("neutral: JSON array payloads with no rule hits", () => {
    expect(classifyFrame("openai-chat", null, "[]")).toBe("neutral");
  });
});

describe("isRequestEchoFrame", () => {
  it("recognizes openai-responses lifecycle echo frames by event name", () => {
    expect(isRequestEchoFrame("openai-responses", "response.created", "{}")).toBe(true);
    expect(isRequestEchoFrame("openai-responses", "response.in_progress", "{}")).toBe(true);
    expect(isRequestEchoFrame("openai-responses", "response.queued", "{}")).toBe(true);
    expect(isRequestEchoFrame("openai-responses", "response.output_text.delta", "{}")).toBe(false);
  });

  it("sniffs the data head when the event line is absent", () => {
    expect(
      isRequestEchoFrame("openai-responses", null, '{"type":"response.created","response":{}}')
    ).toBe(true);
    expect(isRequestEchoFrame("openai-responses", null, '{"type":"other"}')).toBe(false);
    // type 不在头部 64 字节内则不嗅探（上游实践中 type 总在最前）
    expect(
      isRequestEchoFrame(
        "openai-responses",
        null,
        `{"pad":"${"z".repeat(80)}","type":"response.created"}`
      )
    ).toBe(false);
  });

  it("never matches for families without echo frames", () => {
    expect(isRequestEchoFrame("anthropic", "response.created", "{}")).toBe(false);
    expect(isRequestEchoFrame("openai-chat", null, '{"type":"response.created"}')).toBe(false);
    expect(isRequestEchoFrame("gemini", null, '{"type":"response.created"}')).toBe(false);
  });
});

describe("isCleanResponsesCompletion", () => {
  const frame = (type: string, response: Record<string, unknown>) =>
    JSON.stringify({ type, response });

  it.each(["response.completed", "response.done"])(
    "accepts a clean %s with or without the event line",
    (type) => {
      const data = frame(type, { status: "completed", output: [], error: null });
      expect(isCleanResponsesCompletion(type, data)).toBe(true);
      expect(isCleanResponsesCompletion(null, data)).toBe(true);
      expect(isCleanResponsesCompletion(type, frame(type, { status: "failed" }))).toBe(false);
      expect(
        isCleanResponsesCompletion(
          type,
          frame(type, { status: "completed", error: { message: "boom" } })
        )
      ).toBe(false);
    }
  );

  it("rejects an event line that disagrees with the payload type", () => {
    const done = frame("response.done", { status: "completed" });
    const completed = frame("response.completed", { status: "completed" });
    expect(isCleanResponsesCompletion("response.completed", done)).toBe(false);
    expect(isCleanResponsesCompletion("response.done", completed)).toBe(false);
    expect(
      isCleanResponsesCompletion(
        "response.incomplete",
        frame("response.incomplete", { status: "completed" })
      )
    ).toBe(false);
  });
});
