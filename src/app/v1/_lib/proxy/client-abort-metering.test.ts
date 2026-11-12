import { describe, expect, it } from "vitest";
import {
  CLIENT_ABORT_METER_DEFAULT_MAX_FRAME_CHARACTERS,
  CLIENT_ABORT_METER_MAX_RETAINED_BYTES,
  createClientAbortMeteringObserver,
} from "./client-abort-metering";

const encoder = new TextEncoder();

describe("createClientAbortMeteringObserver", () => {
  it("keeps only compact Responses accounting evidence", () => {
    const observer = createClientAbortMeteringObserver("response");
    observer.observe(
      encoder.encode(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "x".repeat(32 * 1024),
        })}\n\n`
      )
    );
    const result = observer.observe(
      encoder.encode(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_1",
            model: "gpt-test",
            output: [{ content: [{ text: "discard me" }] }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        })}\n\n`
      )
    );

    const snapshot = observer.finish();
    expect(result.terminalSeen).toBe(true);
    expect(snapshot.text).toContain("response.completed");
    expect(snapshot.text).toContain('"input_tokens":10');
    expect(snapshot.text).not.toContain("discard me");
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(CLIENT_ABORT_METER_MAX_RETAINED_BYTES);
  });

  it("reserves frame growth before retaining input and releases frame storage on completion", () => {
    const observer = createClientAbortMeteringObserver("response", {
      maxFrameCharacters: 1024 * 1024,
    });
    let reserved = 0;
    const reserve = (bytes: number) => {
      reserved = Math.max(reserved, bytes);
      if (bytes > 1024) throw new Error("memory budget exhausted");
    };
    observer.observe(
      encoder.encode('event: response.completed\ndata: {"type":"response.completed",'),
      reserve
    );
    const before = observer.inFlightFrameBytes;
    expect(before).toBeGreaterThan(0);
    expect(reserved).toBeGreaterThanOrEqual(before);
    expect(() => observer.observe(encoder.encode("x".repeat(2048)), reserve)).toThrow(
      "memory budget exhausted"
    );
    expect(observer.inFlightFrameBytes).toBe(before);
    observer.observe(
      encoder.encode(
        '"response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":2}}}\n\n'
      ),
      reserve
    );
    expect(observer.inFlightFrameBytes).toBe(0);
    expect(observer.finish().terminalSeen).toBe(true);
  });

  it.each([0, 16 * 1024, 96 * 1024])(
    "retains compact usage from a 128 KiB+ terminal after detaching at byte %i",
    (detachOffset) => {
      const maxFrameCharacters = 256 * 1024;
      const observer = createClientAbortMeteringObserver("response", { maxFrameCharacters });
      const bytes = encoder.encode(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_large",
            model: "gpt-test",
            status: "completed",
            output: [{ content: [{ text: "x".repeat(128 * 1024) }] }],
            usage: { input_tokens: 37, output_tokens: 8 },
          },
        })}\n\n`
      );
      expect(bytes.byteLength).toBeGreaterThan(128 * 1024);

      for (let offset = 0; offset < detachOffset; offset += 4096) {
        observer.observe(bytes.subarray(offset, Math.min(offset + 4096, detachOffset)));
      }
      // Detaching changes the caller, not the protocol input limit. Its snapshot
      // must not flush a partial frame or reduce the reserved framing memory.
      expect(observer.snapshot()).toMatchObject({
        text: "",
        terminalSeen: false,
        protocolFailure: null,
      });
      expect(observer.maxInFlightFrameBytes).toBe(maxFrameCharacters * 2);

      for (let offset = detachOffset; offset < bytes.byteLength; offset += 4096) {
        observer.observe(bytes.subarray(offset, offset + 4096));
        expect(observer.maxInFlightFrameBytes).toBe(maxFrameCharacters * 2);
        expect(observer.snapshot().retainedBytes).toBeLessThanOrEqual(
          CLIENT_ABORT_METER_MAX_RETAINED_BYTES
        );
      }
      const snapshot = observer.finish();
      expect(snapshot).toMatchObject({
        terminalSeen: true,
        skippedOversizedFrames: 0,
        protocolFailure: null,
      });
      expect(snapshot.text).toContain('"input_tokens":37');
      expect(snapshot.text).toContain('"output_tokens":8');
      expect(snapshot.text).not.toContain('"output":');
      expect(snapshot.retainedBytes).toBe(encoder.encode(snapshot.text).byteLength);
      expect(snapshot.retainedBytes).toBeLessThan(512);
      expect(observer.maxInFlightFrameBytes).toBe(maxFrameCharacters * 2);
    }
  );

  it.each(["malformed", "truncated", "over-limit"] as const)(
    "does not promote usage from a large %s terminal after detach",
    (kind) => {
      const maxFrameCharacters = 256 * 1024;
      const observer = createClientAbortMeteringObserver("response", { maxFrameCharacters });
      const payload = JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 37, output_tokens: 8 },
          output: [
            { content: [{ text: "x".repeat(kind === "over-limit" ? 256 * 1024 : 128 * 1024) }] },
          ],
        },
      });
      const data =
        kind === "malformed"
          ? `${payload} trailing-invalid-json\n\n`
          : kind === "truncated"
            ? payload.slice(0, -1)
            : `${payload}\n\n`;
      const bytes = encoder.encode(`event: response.completed\ndata: ${data}`);
      const detachOffset = 32 * 1024;
      observer.observe(bytes.subarray(0, detachOffset));
      expect(observer.snapshot().text).toBe("");

      for (let offset = detachOffset; offset < bytes.byteLength; offset += 4096) {
        expect(observer.observe(bytes.subarray(offset, offset + 4096)).terminalSeen).toBe(false);
      }
      const snapshot = observer.finish();
      expect(snapshot).toMatchObject({ terminalSeen: false, text: "", retainedBytes: 0 });
      expect(snapshot.skippedOversizedFrames).toBe(kind === "over-limit" ? 1 : 0);
      if (kind !== "over-limit") {
        expect(snapshot.protocolFailure?.verdict).toBe("malformed");
      }
      expect(observer.maxInFlightFrameBytes).toBe(maxFrameCharacters * 2);
    }
  );

  it.each([undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "reports the default bounded frame reservation for invalid input limit %s",
    (maxFrameCharacters) => {
      const observer = createClientAbortMeteringObserver("response", { maxFrameCharacters });
      expect(observer.maxInFlightFrameBytes).toBe(
        CLIENT_ABORT_METER_DEFAULT_MAX_FRAME_CHARACTERS * 2
      );
      expect(observer.snapshot().retainedBytes).toBe(0);
    }
  );

  it("meters Interactions completion and accepts its following compatibility done event", () => {
    const observer = createClientAbortMeteringObserver("gemini", {
      protocolFamily: "gemini-interactions",
    });
    observer.observe(
      encoder.encode(
        'event: step.delta\ndata: {"index":0,"delta":{"text":"HYDROGEN_READY","type":"text"},"event_type":"step.delta"}\n\n'
      )
    );
    expect(observer.snapshot()).toMatchObject({ sawContent: true, terminalSeen: false });
    const result = observer.observe(
      encoder.encode(
        `event: interaction.completed\ndata: ${JSON.stringify({
          event_type: "interaction.completed",
          interaction: {
            object: "interaction",
            status: "completed",
            model: "gemini-interactions-test",
            outputs: [{ text: "discard generated content" }],
            usage: {
              total_tokens: 45,
              total_input_tokens: 37,
              total_cached_tokens: 3,
              total_output_tokens: 8,
              total_thought_tokens: 2,
              total_tool_use_tokens: 0,
              input_tokens_by_modality: [{ modality: "text", tokens: 37 }],
              output_tokens_by_modality: [{ modality: "text", tokens: 8 }],
            },
          },
        })}\n\n`
      )
    );
    expect(result).toEqual({
      drainComplete: true,
      errorSeen: false,
      protocolFailure: null,
      replayDrainComplete: true,
      terminalSeen: true,
    });
    expect(observer.observe(encoder.encode("event: done\ndata: [DONE]\n\n"))).toEqual(result);

    const snapshot = observer.finish();
    expect(snapshot).toMatchObject({
      sawContent: true,
      terminalSeen: true,
      protocolFailure: null,
      skippedOversizedFrames: 0,
    });
    expect(snapshot.text).toContain('"event_type":"interaction.completed"');
    expect(snapshot.text).toContain('"model":"gemini-interactions-test"');
    expect(snapshot.text).toContain('"total_input_tokens":37');
    expect(snapshot.text).toContain('"total_output_tokens":8');
    expect(snapshot.text).toContain('"total_cached_tokens":3');
    expect(snapshot.text).toContain('"total_thought_tokens":2');
    expect(snapshot.text).toContain('"input_tokens_by_modality":[{"modality":"text","tokens":37}]');
    expect(snapshot.text).toContain('"output_tokens_by_modality":[{"modality":"text","tokens":8}]');
    expect(snapshot.text).toContain("event: done\ndata: [DONE]");
    expect(snapshot.text).not.toContain("HYDROGEN_READY");
    expect(snapshot.text).not.toContain("discard generated content");
    expect(snapshot.retainedBytes).toBe(encoder.encode(snapshot.text).byteLength);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(CLIENT_ABORT_METER_MAX_RETAINED_BYTES);
  });

  it.each(
    [null, "interaction.completed"].flatMap((eventName) =>
      ["completed", "requires_action"].map((status) => ({ eventName, status }))
    )
  )(
    "retains explicit zero Interactions usage with event=$eventName and status=$status",
    ({ eventName, status }) => {
      const observer = createClientAbortMeteringObserver("response", {
        protocolFamily: "gemini-interactions",
      });
      const prefix = eventName === null ? "" : `event: ${eventName}\n`;
      observer.observe(
        encoder.encode(
          `${prefix}data: {"event_type":"interaction.completed","interaction":{"status":"${status}","usage":{"total_input_tokens":0,"total_output_tokens":0}}}\n\n`
        )
      );

      const snapshot = observer.finish();
      expect(snapshot).toMatchObject({ terminalSeen: true, protocolFailure: null });
      expect(snapshot.text).toContain('"total_input_tokens":0');
      expect(snapshot.text).toContain('"total_output_tokens":0');
    }
  );

  it.each([
    { status: "failed", usage: { total_input_tokens: 37, total_output_tokens: 8 } },
    { status: "incomplete", usage: { total_input_tokens: 37, total_output_tokens: 8 } },
    { status: "in_progress", usage: { total_input_tokens: 37, total_output_tokens: 8 } },
    { status: "cancelled", usage: { total_input_tokens: 37, total_output_tokens: 8 } },
    { status: "completed" },
    { status: "completed", usage: {} },
    { status: "completed", usage: { total_input_tokens: 37 } },
    { status: "completed", usage: { total_input_tokens: "37", total_output_tokens: 8 } },
    { status: "completed", usage: { total_input_tokens: -1, total_output_tokens: 8 } },
    { status: "completed", usage: { total_input_tokens: 37, total_output_tokens: null } },
    { status: "completed", usage: { total_input_tokens: 37, total_output_tokens: -1 } },
    {
      status: "completed",
      usage: { total_input_tokens: 37, total_output_tokens: 8, total_cached_tokens: -1 },
    },
    {
      status: "completed",
      usage: { total_input_tokens: 37, total_output_tokens: 8, total_thought_tokens: "2" },
    },
    {
      status: "completed",
      error: { message: "generation failed" },
      usage: { total_input_tokens: 37, total_output_tokens: 8 },
    },
  ])("does not promote an invalid Interactions lifecycle or usage: %j", (interaction) => {
    const observer = createClientAbortMeteringObserver("gemini", {
      protocolFamily: "gemini-interactions",
    });
    const result = observer.observe(
      encoder.encode(
        `event: interaction.completed\ndata: ${JSON.stringify({
          event_type: "interaction.completed",
          interaction,
        })}\n\n`
      )
    );
    expect(result.terminalSeen).toBe(false);
    observer.observe(encoder.encode("event: done\ndata: [DONE]\n\n"));
    expect(observer.finish().terminalSeen).toBe(false);
    expect(observer.finish().protocolFailure).not.toBeNull();
  });

  it.each([
    "event: done\ndata: [DONE]\n\n",
    "data: [DONE]\n\n",
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":\n\n',
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":',
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed","usage":{"total_input_tokens":1e400,"total_output_tokens":8}}}\n\n',
    'event: interaction.completed\ndata: {"event_type":"interaction.failed","interaction":{"status":"completed","usage":{"total_input_tokens":37,"total_output_tokens":8}}}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":37,"output_tokens":8}}}\n\n',
  ])("does not manufacture Interactions completion from invalid data: %s", (frame) => {
    const observer = createClientAbortMeteringObserver("response", {
      protocolFamily: "gemini-interactions",
    });
    observer.observe(encoder.encode(frame));

    expect(observer.finish().terminalSeen).toBe(false);
    expect(observer.finish().text).not.toContain("[DONE]");
  });

  it.each(["", "event: message\n"])(
    "accepts an Interactions compatibility marker only after completion: %j",
    (prefix) => {
      const observer = createClientAbortMeteringObserver("openai", {
        protocolFamily: "gemini-interactions",
      });
      observer.observe(
        encoder.encode(
          'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed","usage":{"total_input_tokens":37,"total_output_tokens":8}}}\n\n'
        )
      );
      observer.observe(encoder.encode(`${prefix}data: [DONE]\n\n`));
      expect(observer.finish()).toMatchObject({ terminalSeen: true, protocolFailure: null });
      expect(observer.finish().text).toContain('"total_input_tokens":37');
    }
  );

  it("retains an incomplete Interactions terminal without marking it successful", () => {
    const observer = createClientAbortMeteringObserver("gemini", {
      protocolFamily: "gemini-interactions",
    });
    const result = observer.observe(
      encoder.encode(
        'event: interaction.incomplete\ndata: {"event_type":"interaction.incomplete","interaction":{"status":"incomplete","usage":{"total_input_tokens":37,"total_output_tokens":8}}}\n\n'
      )
    );
    expect(result).toMatchObject({
      drainComplete: true,
      terminalSeen: false,
      replayDrainComplete: true,
    });
    expect(observer.snapshot()).toMatchObject({ incompleteSeen: true, terminalSeen: false });
    observer.observe(encoder.encode("event: done\ndata: [DONE]\n\n"));
    expect(observer.finish().terminalSeen).toBe(false);
    expect(observer.finish().protocolFailure?.verdict).toBe("malformed");
  });

  it("does not turn invalid optional usage into valid compact Interactions evidence", () => {
    const observer = createClientAbortMeteringObserver("gemini", {
      protocolFamily: "gemini-interactions",
    });
    observer.observe(
      encoder.encode(
        'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"status":"completed","model":"gemini-test","usage":{"total_input_tokens":37,"total_output_tokens":8,"total_tokens":-1}}}\n\n'
      )
    );
    expect(observer.finish()).toMatchObject({
      text: "",
      terminalSeen: false,
      protocolFailure: { verdict: "malformed" },
    });
  });

  it("records Interactions failures after content without reporting completion", () => {
    const observer = createClientAbortMeteringObserver("gemini", {
      protocolFamily: "gemini-interactions",
    });
    observer.observe(
      encoder.encode(
        'event: step.delta\ndata: {"index":0,"event_type":"step.delta","delta":{"type":"text","text":"partial"}}\n\n'
      )
    );
    const result = observer.observe(
      encoder.encode(
        'event: interaction.failed\ndata: {"event_type":"interaction.failed","interaction":{"status":"failed","error":{"message":"upstream failed"}}}\n\n'
      )
    );
    expect(result).toMatchObject({
      terminalSeen: false,
      errorSeen: true,
      protocolFailure: { afterContent: true, verdict: "error", eventName: "interaction.failed" },
    });
    expect(observer.finish().text).toContain("upstream failed");
    expect(observer.finish().text).not.toContain('"text":"partial"');
  });

  it("retains only bounded Interactions usage when detaching within a large completion frame", () => {
    const maxFrameCharacters = 256 * 1024;
    const observer = createClientAbortMeteringObserver("gemini", {
      maxFrameCharacters,
      protocolFamily: "gemini-interactions",
    });
    const bytes = encoder.encode(
      `event: interaction.completed\ndata: ${JSON.stringify({
        event_type: "interaction.completed",
        interaction: {
          status: "completed",
          model: "gemini-interactions-test",
          outputs: [{ text: "x".repeat(128 * 1024) }],
          usage: {
            total_input_tokens: 37,
            total_output_tokens: 8,
            total_cached_tokens: 0,
            total_thought_tokens: 0,
            input_tokens_by_modality: Array.from({ length: 20 }, (_, index) => ({
              modality: "text",
              tokens: index,
              content: "discard modality content",
            })),
          },
        },
      })}\n\n`
    );
    observer.observe(bytes.subarray(0, 32 * 1024));
    expect(observer.snapshot()).toMatchObject({ text: "", terminalSeen: false });
    for (let offset = 32 * 1024; offset < bytes.byteLength; offset += 4096) {
      observer.observe(bytes.subarray(offset, offset + 4096));
      expect(observer.maxInFlightFrameBytes).toBe(maxFrameCharacters * 2);
    }

    const snapshot = observer.finish();
    expect(snapshot).toMatchObject({ terminalSeen: true, protocolFailure: null });
    expect(snapshot.text).toContain('"total_input_tokens":37');
    expect(snapshot.text).toContain('"total_output_tokens":8');
    expect(snapshot.text).toContain('"tokens":15');
    expect(snapshot.text).not.toContain('"tokens":16');
    expect(snapshot.text).not.toContain('"outputs"');
    expect(snapshot.text).not.toContain("discard modality content");
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(CLIENT_ABORT_METER_MAX_RETAINED_BYTES);
  });

  it.each(["response", "claude", "gemini", "gemini-cli"] as const)(
    "keeps the done sentinel invalid for %s",
    (format) => {
      const observer = createClientAbortMeteringObserver(format);
      expect(observer.observe(encoder.encode("event: done\ndata: [DONE]\n\n"))).toMatchObject({
        terminalSeen: false,
        protocolFailure: { verdict: "malformed", eventName: "done" },
      });
      expect(observer.finish().text).toBe("");
    }
  );

  it("snapshots only complete frames without ending the usage drain", () => {
    const observer = createClientAbortMeteringObserver("response");
    observer.observe(
      encoder.encode('event: response.completed\ndata: {"type":"response.completed","response":')
    );
    const before = observer.snapshot();
    expect(before).toMatchObject({ terminalSeen: false, text: "", protocolFailure: null });

    observer.observe(encoder.encode('{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n'));
    expect(observer.finish()).toMatchObject({ terminalSeen: true, protocolFailure: null });
    expect(observer.finish().text).toContain('"output_tokens":5');
    expect(before).toMatchObject({ terminalSeen: false, text: "", protocolFailure: null });
  });

  it("retains a complete message-only fake-200 error without promoting a partial frame", () => {
    const observer = createClientAbortMeteringObserver("response");
    observer.observe(encoder.encode('data: {"message":"upstream error"}'));
    const before = observer.snapshot();
    expect(before.text).toBe("");

    observer.observe(encoder.encode("\n\n"));
    const complete = observer.snapshot();
    expect(complete.text).toBe('data: {"message":"upstream error"}\n\n');
    expect(complete.protocolFailure).toBeNull();
    expect(complete.retainedBytes).toBeLessThanOrEqual(CLIENT_ABORT_METER_MAX_RETAINED_BYTES);
    expect(before.text).toBe("");
  });

  it.each([
    { message: "upstream error", padding: "x".repeat(1000) },
    { message: "normal bookkeeping" },
    { choices: [{ delta: { content: "upstream error" } }] },
  ])("does not invent fake-200 evidence from a neutral frame: %j", (payload) => {
    const observer = createClientAbortMeteringObserver("openai");
    observer.observe(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

    expect(observer.snapshot().text).toBe("");
    expect(observer.snapshot().protocolFailure).toBeNull();
  });

  it("retains Claude initial and terminal usage until message_stop", () => {
    const observer = createClientAbortMeteringObserver("claude");
    observer.observe(
      encoder.encode(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { model: "claude-test", usage: { input_tokens: 20, output_tokens: 1 } },
        })}\n\n`
      )
    );
    expect(
      observer.observe(
        encoder.encode(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            usage: { output_tokens: 7 },
          })}\n\n`
        )
      ).terminalSeen
    ).toBe(false);
    expect(
      observer.observe(encoder.encode(`event: message_stop\ndata: {"type":"message_stop"}\n\n`))
        .terminalSeen
    ).toBe(true);

    const snapshot = observer.finish();
    expect(snapshot.text).toContain("message_start");
    expect(snapshot.text).toContain("message_delta");
    expect(snapshot.text).toContain("message_stop");
  });

  it("skips an oversized content frame and resumes at the next frame boundary", () => {
    const observer = createClientAbortMeteringObserver("response");
    const result = observer.observe(
      encoder.encode(
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "x".repeat(70 * 1024),
        })}\n\nevent: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: { usage: { input_tokens: 10, output_tokens: 5 } },
        })}\n\n`
      )
    );

    const snapshot = observer.finish();
    expect(result.terminalSeen).toBe(true);
    expect(snapshot.skippedOversizedFrames).toBe(1);
    expect(snapshot.text).toContain("response.completed");
  });

  it("stops metering at an OpenAI done marker without requiring usage", () => {
    const observer = createClientAbortMeteringObserver("openai");
    expect(observer.observe(encoder.encode("data: [DONE]\n\n")).terminalSeen).toBe(true);
    expect(observer.finish().terminalSeen).toBe(true);
  });

  it("treats a valid Responses terminal without usage as complete", () => {
    const observer = createClientAbortMeteringObserver("response");
    const result = observer.observe(
      encoder.encode(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      )
    );

    expect(result).toEqual({
      drainComplete: true,
      errorSeen: false,
      protocolFailure: null,
      replayDrainComplete: true,
      terminalSeen: true,
    });
    expect(observer.finish().terminalSeen).toBe(true);
  });

  it("does not treat standard nullable Responses error fields as protocol failures", () => {
    const observer = createClientAbortMeteringObserver("response");
    const result = observer.observe(
      encoder.encode(
        'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","error":null,"usage":{"input_tokens":4,"output_tokens":2}}}\n\n'
      )
    );

    expect(result).toEqual({
      drainComplete: true,
      errorSeen: false,
      protocolFailure: null,
      replayDrainComplete: true,
      terminalSeen: true,
    });
    expect(observer.finish().protocolFailure).toBeNull();
  });

  it("retains zero-valued usage without making it a completion requirement", () => {
    const observer = createClientAbortMeteringObserver("response");
    observer.observe(
      encoder.encode(
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n'
      )
    );

    const snapshot = observer.finish();
    expect(snapshot.terminalSeen).toBe(true);
    expect(snapshot.text).toContain('"input_tokens":0');
    expect(snapshot.text).toContain('"output_tokens":0');
  });

  it("does not treat initial Claude usage as a completed stream", () => {
    const observer = createClientAbortMeteringObserver("claude");
    observer.observe(
      encoder.encode(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n'
      )
    );

    const snapshot = observer.finish();
    expect(snapshot.terminalSeen).toBe(false);
    expect(snapshot.text).toContain('"input_tokens":12');
  });

  it("combines an OpenAI usage chunk with a later done marker across arbitrary splits", () => {
    const observer = createClientAbortMeteringObserver("openai");
    const text = `data: ${JSON.stringify({
      id: "chatcmpl_1",
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 4 },
    })}\r\n\r\ndata: [DONE]\r\n\r\n`;
    const bytes = encoder.encode(text);
    for (let offset = 0; offset < bytes.length; offset += 7) {
      observer.observe(bytes.subarray(offset, offset + 7));
    }

    const snapshot = observer.finish();
    expect(snapshot.terminalSeen).toBe(true);
    expect(snapshot.text).toContain('"prompt_tokens":12');
    expect(snapshot.text).toContain("[DONE]");
  });

  it("waits for OpenAI usage after finish_reason before ending the drain", () => {
    const observer = createClientAbortMeteringObserver("openai");

    expect(
      observer.observe(
        encoder.encode('data: {"choices":[{"finish_reason":"stop"}],"usage":null}\n\n')
      )
    ).toEqual({
      drainComplete: false,
      errorSeen: false,
      protocolFailure: null,
      replayDrainComplete: false,
      terminalSeen: true,
    });
    expect(
      observer.observe(
        encoder.encode(
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n'
        )
      )
    ).toEqual({
      drainComplete: true,
      errorSeen: false,
      protocolFailure: null,
      replayDrainComplete: false,
      terminalSeen: true,
    });

    expect(observer.finish().text).toContain('"completion_tokens":4');
  });

  it("uses the last Gemini NDJSON usage and finishReason as terminal evidence", () => {
    const observer = createClientAbortMeteringObserver("gemini");
    observer.observe(
      encoder.encode(
        `${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "discard" }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
        })}\n`
      )
    );
    const result = observer.observe(
      encoder.encode(
        `${JSON.stringify({
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 },
        })}\n`
      )
    );

    const snapshot = observer.finish();
    expect(result.terminalSeen).toBe(true);
    expect(snapshot.text).toContain('"candidatesTokenCount":8');
    expect(snapshot.text).not.toContain("discard");
  });

  it("retains compact protocol errors without retaining content", () => {
    const observer = createClientAbortMeteringObserver("response");
    observer.observe(
      encoder.encode(
        `event: error\ndata: ${JSON.stringify({
          type: "response.error",
          error: { code: "upstream_failed", message: "failure" },
          debug: "x".repeat(32 * 1024),
        })}\n\n`
      )
    );

    const snapshot = observer.finish();
    expect(snapshot.terminalSeen).toBe(false);
    expect(snapshot.text).toContain("upstream_failed");
    expect(snapshot.text).not.toContain('"debug"');
  });

  it("compacts extended usage, metadata, cache, and signature evidence", () => {
    const observer = createClientAbortMeteringObserver("response");
    observer.observe(
      encoder.encode(
        `event: response.in_progress\ndata: ${JSON.stringify({
          id: "resp_extended",
          model: "gpt-extended",
          prompt_cache_key: "cache-key",
          service_tier: "priority",
          status: "in_progress",
          type: "response.in_progress",
          message: {
            id: "message-1",
            model: "gpt-message",
            usage: { input_tokens: 1 },
          },
          delta: {
            type: "signature_delta",
            stop_reason: "end_turn",
            signature: "signed-model",
            usage: { output_tokens: 2 },
          },
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            cache_creation_input_tokens: 2,
            cache_creation_5m_input_tokens: 1,
            cache_creation_1h_input_tokens: 1,
            cache_read_input_tokens: 4,
            input_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
            prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 },
            cache_creation: {
              ephemeral_5m_input_tokens: 1,
              ephemeral_1h_input_tokens: 1,
            },
            candidatesTokensDetails: [
              null,
              {},
              { modality: "TEXT", tokenCount: 2 },
              { tokenCount: 1 },
            ],
            promptTokensDetails: [{ modality: "IMAGE", tokenCount: 3 }],
          },
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
          choices: [null, {}, { finish_reason: "stop" }],
          candidates: [null, {}, { finishReason: "STOP" }],
          ignored: "not retained",
        })}\n\n`
      )
    );
    observer.observe(
      encoder.encode(
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_extended",
            model: "gpt-extended",
            service_tier: "priority",
            usage: { input_tokens: 10, output_tokens: 3 },
          },
        })}\n\n`
      )
    );

    const snapshot = observer.finish();
    expect(snapshot.terminalSeen).toBe(true);
    expect(snapshot.text).toContain('"prompt_cache_key":"cache-key"');
    expect(snapshot.text).toContain('"signature":"signed-model"');
    expect(snapshot.text).toContain('"cache_write_tokens":2');
    expect(snapshot.text).toContain('"modality":"IMAGE"');
    expect(snapshot.text).not.toContain("not retained");
  });

  it("handles comments, multi-line data, bare JSON tails, and malformed frames", () => {
    const observer = createClientAbortMeteringObserver("gemini-cli");
    observer.observe(new Uint8Array());
    observer.observe(
      encoder.encode(
        ': keepalive\rretry: 1000\revent: message\rdata: {"usageMetadata":\rdata: {"promptTokenCount":10,"candidatesTokenCount":2}}\r\r'
      )
    );
    observer.observe(encoder.encode("data: true\n\n"));
    observer.observe(encoder.encode("data: not-json\n\n"));
    observer.observe(encoder.encode("data: still-not-json\n\n"));
    observer.observe(
      encoder.encode(
        JSON.stringify({
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
        })
      )
    );

    const snapshot = observer.finish();
    expect(snapshot.terminalSeen).toBe(true);
    expect(snapshot.protocolFailure).toEqual({
      afterContent: false,
      verdict: "malformed",
      eventName: null,
    });
  });

  it("recovers after an oversized bare JSON line and ignores post-finish input", () => {
    const observer = createClientAbortMeteringObserver("gemini");
    observer.observe(encoder.encode(`{"ignored":"${"x".repeat(70 * 1024)}"}\n`));
    observer.observe(
      encoder.encode(
        `${JSON.stringify({
          candidates: [{ finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
        })}`
      )
    );
    const first = observer.finish();
    observer.observe(encoder.encode('{"error":true}\n'));
    const second = observer.finish();

    expect(first.terminalSeen).toBe(true);
    expect(first.skippedOversizedFrames).toBe(1);
    expect(second).toEqual(first);
  });

  it("does not fabricate completion from an oversized unvalidated terminal frame", () => {
    const observer = createClientAbortMeteringObserver("response");
    const partial = observer.observe(
      encoder.encode(
        'event: response.completed\ndata: {"type":"response.completed","padding":"' +
          "x".repeat(70 * 1024)
      )
    );

    expect(partial).toEqual({
      drainComplete: false,
      errorSeen: false,
      protocolFailure: null,
      replayDrainComplete: false,
      terminalSeen: false,
    });
    const completed = observer.observe(encoder.encode('"}\n\n'));
    expect(completed).toEqual({
      drainComplete: false,
      errorSeen: false,
      protocolFailure: null,
      replayDrainComplete: false,
      terminalSeen: false,
    });
    const snapshot = observer.finish();
    expect(snapshot.skippedOversizedFrames).toBe(1);
    expect(snapshot.text).not.toContain("response.completed");
  });

  it("recovers at the next NDJSON line after snapshotting an in-flight frame", () => {
    const observer = createClientAbortMeteringObserver("gemini", {
      maxFrameCharacters: 128 * 1024,
    });
    observer.observe(
      encoder.encode(`{"candidates":[{"content":{"parts":[{"text":"${"x".repeat(70 * 1024)}`)
    );

    expect(observer.snapshot().terminalSeen).toBe(false);
    const result = observer.observe(
      encoder.encode(
        '"}]}}]}\n{"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3}}\n'
      )
    );

    expect(result.drainComplete).toBe(true);
    expect(observer.finish().text).toContain('"candidatesTokenCount":3');
  });

  it.each([
    'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
    'data: {"type":"response.incomplete","response":{"status":"incomplete"}}\n\n',
  ])("stops at Responses incomplete without treating it as successful completion", (frame) => {
    const observer = createClientAbortMeteringObserver("response");

    expect(observer.observe(encoder.encode(frame))).toEqual({
      drainComplete: true,
      errorSeen: false,
      protocolFailure: null,
      replayDrainComplete: true,
      terminalSeen: false,
    });
    expect(observer.finish()).toMatchObject({ incompleteSeen: true, protocolFailure: null });
  });

  it("records protocol failure after content independently from completion", () => {
    const observer = createClientAbortMeteringObserver("response");
    observer.observe(
      encoder.encode(
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n'
      )
    );
    const result = observer.observe(
      encoder.encode(
        'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n'
      )
    );

    expect(result).toEqual({
      drainComplete: true,
      errorSeen: true,
      protocolFailure: {
        afterContent: true,
        eventName: "response.failed",
        verdict: "error",
      },
      replayDrainComplete: true,
      terminalSeen: false,
    });
    expect(observer.finish().protocolFailure).toEqual({
      afterContent: true,
      verdict: "error",
      eventName: "response.failed",
    });
  });
});
