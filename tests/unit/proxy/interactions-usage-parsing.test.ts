import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createClientAbortMeteringObserver } from "@/app/v1/_lib/proxy/client-abort-metering";
import { parseUsageFromResponseText } from "@/app/v1/_lib/proxy/response-handler";
import { calculateRequestCost } from "@/lib/utils/cost-calculation";

const PATH = "/v1beta/interactions";
const COMPLETED = readFileSync("tests/unit/proxy/fixtures/interactions-completed.sse", "utf8");

describe("Interactions usage accounting", () => {
  it.each(["claude", "gemini", "codex", "openai-compatible"])(
    "extracts the completion usage independently of forwarding provider %s",
    (providerType) => {
      expect(parseUsageFromResponseText(COMPLETED, providerType, PATH).usageMetrics).toEqual({
        input_tokens: 37,
        output_tokens: 8,
        cache_read_input_tokens: 0,
      });
    }
  );

  it.each([false, true])("separates cached input and bills thought tokens, stream=%s", (stream) => {
    const usage = {
      total_input_tokens: 37,
      total_cached_tokens: 12,
      total_output_tokens: 8,
      total_thought_tokens: 5,
    };
    const interaction = { status: "completed", usage };
    const text = stream
      ? `event: interaction.completed\ndata: ${JSON.stringify({
          event_type: "interaction.completed",
          interaction,
        })}\n\n`
      : JSON.stringify(interaction);
    expect(parseUsageFromResponseText(text, "openai-compatible", PATH)).toEqual({
      usageRecord: usage,
      usageMetrics: { input_tokens: 25, output_tokens: 13, cache_read_input_tokens: 12 },
    });
  });

  it.each([false, true])(
    "prices image modalities separately without double billing, stream=%s",
    (stream) => {
      const usage = {
        total_input_tokens: 100,
        total_cached_tokens: 20,
        total_output_tokens: 40,
        total_thought_tokens: 5,
        input_tokens_by_modality: [
          { modality: "text", tokens: 70 },
          { modality: "image", tokens: 30 },
        ],
        output_tokens_by_modality: [
          { modality: "text", tokens: 28 },
          { modality: "image", tokens: 12 },
        ],
      };
      const interaction = { status: "completed", usage };
      const text = stream
        ? `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction })}\n\n`
        : JSON.stringify(interaction);
      const parsed = parseUsageFromResponseText(text, "claude", PATH);
      expect(parsed.usageMetrics).toEqual({
        input_tokens: 50,
        output_tokens: 33,
        cache_read_input_tokens: 20,
        input_image_tokens: 30,
        output_image_tokens: 12,
      });
      expect(
        calculateRequestCost(parsed.usageMetrics!, {
          input_cost_per_token: 0.000001,
          output_cost_per_token: 0.000002,
          cache_read_input_token_cost: 0.0000001,
          input_cost_per_image_token: 0.00001,
          output_cost_per_image_token: 0.00002,
        }).toString()
      ).toBe("0.000658");
    }
  );

  it.each(
    [false, true].flatMap((stream) =>
      ["image", "document"].flatMap((modality) => [
        {
          stream,
          modality,
          toolTokens: 40,
          toolImage: 30,
          input: 16,
          image: 32,
          cost: "0.0003522",
        },
        {
          stream,
          modality,
          toolTokens: 40,
          toolImage: 999,
          input: 6,
          image: 42,
          cost: "0.0004422",
        },
        { stream, modality, toolTokens: 0, toolImage: 999, input: 6, image: 2, cost: "0.0000422" },
      ])
    )
  )(
    "bills tool prompt $modality tokens without recharging cached input: $stream/$toolTokens/$toolImage",
    ({ stream, modality, toolTokens, toolImage, input, image, cost }) => {
      const interaction = {
        status: "completed",
        usage: {
          total_input_tokens: 10,
          total_cached_tokens: 2,
          total_tool_use_tokens: toolTokens,
          total_output_tokens: 3,
          total_thought_tokens: 5,
          input_tokens_by_modality: [{ modality, tokens: 4 }],
          cached_tokens_by_modality: [{ modality, tokens: 2 }],
          tool_use_tokens_by_modality: [{ modality, tokens: toolImage }],
        },
      };
      const text = stream
        ? `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction })}\n\nevent: done\ndata: [DONE]\n\n`
        : JSON.stringify(interaction);
      let evidence = text;
      if (stream) {
        const meter = createClientAbortMeteringObserver("claude", {
          protocolFamily: "gemini-interactions",
        });
        meter.observe(new TextEncoder().encode(text));
        evidence = meter.finish().text;
      }
      const { usageMetrics } = parseUsageFromResponseText(evidence, "claude", PATH);
      expect(usageMetrics).toEqual({
        input_tokens: input,
        input_image_tokens: image,
        output_tokens: 8,
        cache_read_input_tokens: 2,
      });
      expect(
        calculateRequestCost(usageMetrics!, {
          input_cost_per_token: 0.000001,
          input_cost_per_image_token: 0.00001,
          output_cost_per_token: 0.000002,
          cache_read_input_token_cost: 0.0000001,
        }).toString()
      ).toBe(cost);
    }
  );

  it("bounds modality counters by billable totals and ignores invalid detail counters", () => {
    expect(
      parseUsageFromResponseText(
        JSON.stringify({
          usage: {
            total_input_tokens: 10,
            total_cached_tokens: 8,
            total_output_tokens: 3,
            input_tokens_by_modality: [{ modality: "image", tokens: 10 }],
            output_tokens_by_modality: [
              { modality: "image", tokens: -1 },
              { modality: "image", tokens: 5 },
            ],
          },
        }),
        "claude",
        PATH
      ).usageMetrics
    ).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 8,
      input_image_tokens: 2,
      output_image_tokens: 3,
    });
  });

  it.each([
    { cachedImage: 0, cost: "0.000343" },
    { cachedImage: 10, cost: "0.000253" },
    { cachedImage: 30, cost: "0.000073" },
  ])("charges only uncached image input, cached images=$cachedImage", ({ cachedImage, cost }) => {
    const parsed = parseUsageFromResponseText(
      JSON.stringify({
        usage: {
          total_input_tokens: 100,
          total_cached_tokens: 30,
          total_output_tokens: 0,
          input_tokens_by_modality: [
            { modality: "text", tokens: 70 },
            { modality: "image", tokens: 30 },
          ],
          cached_tokens_by_modality: [
            { modality: "image", tokens: cachedImage },
            { modality: "text", tokens: 30 - cachedImage },
          ],
        },
      }),
      "claude",
      PATH
    );
    expect(parsed.usageMetrics).toMatchObject({
      input_tokens: 40 + cachedImage,
      cache_read_input_tokens: 30,
    });
    expect(parsed.usageMetrics?.input_image_tokens ?? 0).toBe(30 - cachedImage);
    expect(
      calculateRequestCost(parsed.usageMetrics!, {
        input_cost_per_token: 0.000001,
        input_cost_per_image_token: 0.00001,
        cache_read_input_token_cost: 0.0000001,
      }).toString()
    ).toBe(cost);
  });

  it.each([
    { event: "interaction.incomplete", status: "incomplete" },
    { event: "interaction.completed", status: "incomplete" },
    { event: "interaction.status_update", status: "incomplete" },
    { event: "interaction.failed", status: "failed" },
    { event: "interaction.cancelled", status: "cancelled" },
    { event: "interaction.status_update", status: "failed" },
    { event: "interaction.status_update", status: "cancelled" },
  ])(
    "extracts valid terminal usage independently of success: $event/$status",
    ({ event, status }) => {
      const usage = { total_input_tokens: 7, total_output_tokens: 3 };
      const data =
        event === "interaction.status_update"
          ? { event_type: event, status, usage }
          : { event_type: event, interaction: { status, usage } };
      expect(
        parseUsageFromResponseText(
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          "claude",
          PATH
        ).usageMetrics
      ).toEqual({ input_tokens: 7, output_tokens: 3 });
    }
  );

  it("preserves explicit zero usage and does not invent absent cache usage", () => {
    expect(
      parseUsageFromResponseText(
        '{"usage":{"total_input_tokens":0,"total_output_tokens":0}}',
        "claude",
        `${PATH}/?alt=sse`
      ).usageMetrics
    ).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it.each([
    {},
    { total_input_tokens: 3 },
    { total_input_tokens: -1, total_output_tokens: 2 },
    { total_input_tokens: 3, total_output_tokens: "2" },
    { total_input_tokens: 3, total_output_tokens: 2, total_cached_tokens: -1 },
    { total_input_tokens: 3, total_output_tokens: 2, total_thought_tokens: "2" },
  ])("does not invent billable counters from invalid usage: %j", (usage) => {
    expect(parseUsageFromResponseText(JSON.stringify({ usage }), "claude", PATH)).toEqual({
      usageRecord: null,
      usageMetrics: null,
    });
  });

  it.each(
    ["completed", "incomplete", "failed", "cancelled", "status_update"].flatMap((status) =>
      ["total_cached_tokens", "total_thought_tokens"].map((counter) => ({ status, counter }))
    )
  )("never repairs invalid $counter through compact $status evidence", ({ status, counter }) => {
    const event = `interaction.${status}`;
    const resource = {
      status: status === "status_update" ? "failed" : status,
      usage: { total_input_tokens: 37, total_output_tokens: 8, [counter]: "invalid" },
    };
    const data =
      status === "status_update"
        ? { event_type: event, ...resource }
        : { event_type: event, interaction: resource };
    const wire = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const meter = createClientAbortMeteringObserver("claude", {
      protocolFamily: "gemini-interactions",
    });
    meter.observe(new TextEncoder().encode(wire));
    const snapshot = meter.finish();
    expect(parseUsageFromResponseText(wire, "claude", PATH).usageMetrics).toBeNull();
    expect(parseUsageFromResponseText(snapshot.text, "claude", PATH).usageMetrics).toBeNull();
    expect(snapshot.terminalSeen).toBe(false);
    if (status === "incomplete") expect(snapshot.incompleteSeen).toBe(true);
    if (status === "failed" || status === "cancelled" || status === "status_update") {
      expect(snapshot.protocolFailure?.verdict).toBe("error");
    }
  });

  it.each([
    "",
    "{broken",
    "event: done\ndata: [DONE]\n\n",
    COMPLETED.split("event: interaction.completed")[0],
  ])("does not infer zero-cost completion from absent or truncated usage: %s", (text) => {
    expect(parseUsageFromResponseText(text, "claude", PATH)).toEqual({
      usageRecord: null,
      usageMetrics: null,
    });
  });

  it("keeps native Gemini usage semantics outside Interactions", () => {
    expect(
      parseUsageFromResponseText(
        '{"usageMetadata":{"promptTokenCount":37,"cachedContentTokenCount":12,"candidatesTokenCount":8,"thoughtsTokenCount":5}}',
        "gemini",
        "/v1beta/models/gemini-test:generateContent"
      ).usageMetrics
    ).toEqual({ input_tokens: 25, output_tokens: 13, cache_read_input_tokens: 12 });
  });
});
