import { addProbe, JsonProbe, type JsonSummary, probeSpec } from "@/lib/memory/json-probe";
import {
  type FrameVerdict,
  INTERACTIONS_EVENT_TYPES,
  type ProtocolFamily,
  STREAM_SIGNALS,
} from "./frame-classifier";

type Rule = (typeof STREAM_SIGNALS)[ProtocolFamily]["contentRules"][number];

/** 未进入结构分类的帧（哨兵、空 data、损坏 JSON）不携带终态或工具调用事实。 */
const NOT_STRUCTURED = {
  acceptTerminal: false,
  interactionsCompleted: false,
  toolCallOpen: false,
  toolCallClose: false,
};

function compile(family: ProtocolFamily) {
  const spec = probeSpec();
  let count = BigInt(0);
  const probes = new Map<string, bigint>();
  const query = (
    path: string,
    kind: string,
    test: (value: JsonSummary) => boolean,
    arrays = false
  ) => {
    const key = `${path}:${kind}`;
    const previous = probes.get(key);
    if (previous !== undefined) return previous;
    const bit = BigInt(1) << count++;
    probes.set(key, bit);
    addProbe(spec, path, bit, test, arrays);
    return bit;
  };
  const nonempty = (path: string) => query(path, "nonempty", (value) => value.nonempty);
  const equal = (path: string, value: string, stringOnly = false) =>
    query(
      path,
      `${stringOnly ? "string" : "value"}=${value}`,
      (s) =>
        (s.kind === "string" || (!stringOnly && (s.kind === "number" || s.kind === "boolean"))) &&
        s.text === value,
      !stringOnly && !path.split(".").includes("#")
    );
  const signal = STREAM_SIGNALS[family];
  const toolCallRules = signal.toolCallRules ?? { open: [], close: [] };
  const events = new Set<string>(signal.terminalEvents);
  if (family === "gemini-interactions") {
    for (const event of INTERACTIONS_EVENT_TYPES) events.add(event);
  }
  for (const rule of [
    ...signal.contentRules,
    ...signal.errorRules,
    ...(signal.terminalRules ?? []),
    ...toolCallRules.open,
    ...toolCallRules.close,
  ]) {
    for (const name of rule.eventTypes ?? []) events.add(name);
  }
  const eventQueries = [...events].map(
    (event) =>
      [event, equal(family === "gemini-interactions" ? "event_type" : "type", event, true)] as const
  );
  const wrapEventQueries =
    family === "gemini"
      ? [...events].map((event) => [event, equal("response.type", event, true)] as const)
      : [];
  const ruleTest = (rule: Rule, prefix: string) => {
    const any = (rule.anyPaths ?? []).reduce(
      (mask, path) => mask | nonempty(prefix + path),
      BigInt(0)
    );
    const strings = (rule.anyStringPaths ?? []).reduce(
      (mask, path) =>
        mask | query(prefix + path, "nonemptyString", (s) => s.kind === "string" && s.nonempty),
      BigInt(0)
    );
    const values = (rule.valueMatches ?? []).map((match) =>
      match.values.reduce((mask, value) => mask | equal(prefix + match.path, value), BigInt(0))
    );
    return (facts: bigint, event: string) =>
      (rule.eventTypes?.length ?? 0) +
        (rule.anyPaths?.length ?? 0) +
        (rule.anyStringPaths?.length ?? 0) +
        values.length >
        0 &&
      (!rule.eventTypes?.length || rule.eventTypes.includes(event)) &&
      (any === BigInt(0) || (facts & any) !== BigInt(0)) &&
      (strings === BigInt(0) || (facts & strings) !== BigInt(0)) &&
      values.every((mask) => (facts & mask) !== BigInt(0));
  };
  const buildRules = (prefix: string) => ({
    error: signal.errorRules.map((rule) => ruleTest(rule, prefix)),
    content: signal.contentRules.map((rule) => ruleTest(rule, prefix)),
    terminal: (signal.terminalRules ?? []).map((rule) => ruleTest(rule, prefix)),
  });
  const rules = buildRules("");
  const wrappedRules = family === "gemini" ? buildRules("response.") : null;
  // 工具调用打开/完成只是流级事实；是否提升为 content 由 ProbedSseFrames 按整条流决定。
  const toolCallOpen = toolCallRules.open.map((rule) => ruleTest(rule, ""));
  const toolCallClose = toolCallRules.close.map((rule) => ruleTest(rule, ""));
  const compaction = (path: string) => {
    const type = equal(`${path}.type`, "compaction", true);
    const content = query(
      `${path}.encrypted_content`,
      "nonemptyString",
      (s) => s.kind === "string" && s.nonempty
    );
    const hit = BigInt(1) << count++;
    let target = spec;
    for (const key of path.split(".")) target = target.children.get(key)!;
    target.complete = (facts, value) => {
      const matches =
        value.kind === "object" && (facts & type) !== BigInt(0) && (facts & content) !== BigInt(0);
      return (facts & ~(type | content)) | (matches ? hit : BigInt(0));
    };
    return hit;
  };
  const itemCompaction = family === "openai-responses" ? compaction("item") : BigInt(0);
  const outputCompaction =
    family === "openai-responses" ? compaction("response.output.#") : BigInt(0);
  const completedType = equal("type", "response.completed", true);
  const doneType = equal("type", "response.done", true);
  const incompleteType = equal("type", "response.incomplete", true);
  const completedStatus = equal("response.status", "completed", true);
  const incompleteStatus = equal("response.status", "incomplete", true);
  const responseError = nonempty("response.error");
  const responseObject = query("response", "object", (s) => s.kind === "object");
  const interactionObject = query("interaction", "object", (s) => s.kind === "object");
  const interactionCompleted = equal("interaction.status", "completed", true);
  const interactionRequiresAction = equal("interaction.status", "requires_action", true);
  const interactionIncomplete = equal("interaction.status", "incomplete", true);
  const statusIncomplete = equal("status", "incomplete", true);
  const usageObject = query("interaction.usage", "object", (s) => s.kind === "object");
  const validCounter = (s: JsonSummary) =>
    s.kind === "number" && Number.isFinite(Number(s.text)) && Number(s.text) >= 0;
  const inputTokens = query("interaction.usage.total_input_tokens", "counter", validCounter);
  const outputTokens = query("interaction.usage.total_output_tokens", "counter", validCounter);
  const invalidOptionalCounters = [
    "total_tokens",
    "total_cached_tokens",
    "total_tool_use_tokens",
    "total_thought_tokens",
  ].reduce(
    (mask, key) =>
      mask | query(`interaction.usage.${key}`, "invalidCounter", (s) => !validCounter(s)),
    BigInt(0)
  );
  const stepIndex = query(
    "index",
    "index",
    (s) => s.kind === "number" && Number.isSafeInteger(Number(s.text)) && Number(s.text) >= 0
  );
  const deltaObject = query("delta", "object", (s) => s.kind === "object");
  const deltaType = query("delta.type", "nonemptyString", (s) => s.kind === "string" && s.nonempty);
  const stepObject = query("step", "object", (s) => s.kind === "object");
  const stepType = query("step.type", "nonemptyString", (s) => s.kind === "string" && s.nonempty);
  const classifyRules = (
    facts: bigint,
    event: string,
    group: ReturnType<typeof buildRules>
  ): FrameVerdict => {
    if (group.error.some((test) => test(facts, event))) return "error";
    if (
      (event === "response.output_item.done" && (facts & itemCompaction) !== BigInt(0)) ||
      (event === "response.completed" && (facts & outputCompaction) !== BigInt(0))
    )
      return "content";
    if (group.content.some((test) => test(facts, event))) return "content";
    if (group.terminal.some((test) => test(facts, event)) || signal.terminalEvents?.includes(event))
      return "terminal";
    return "neutral";
  };
  return {
    spec,
    evaluate(parser: JsonProbe, eventName: string | null, head: string, length: number) {
      const trimmed = head.trim();
      if (length <= head.length && signal.doneSentinel && trimmed === signal.doneSentinel)
        return { ...NOT_STRUCTURED, verdict: "terminal" as const };
      if (length <= head.length && trimmed === "")
        return { ...NOT_STRUCTURED, verdict: "neutral" as const };
      if (!parser.finish() || (parser.rootKind !== "object" && parser.rootKind !== "array"))
        return { ...NOT_STRUCTURED, verdict: "malformed" as const };
      const facts = parser.facts;
      const event = (eventName ?? "").trim();
      const effective =
        (family === "gemini-interactions" ? "" : event) ||
        eventQueries.find(([, bit]) => (facts & bit) !== BigInt(0))?.[0] ||
        "";
      if (family === "gemini-interactions") {
        const aligned =
          parser.rootKind === "object" &&
          effective !== "" &&
          (event === "" || event === "message" || event === effective);
        if (!aligned) return { ...NOT_STRUCTURED, verdict: "malformed" as const };
        if (rules.error.some((test) => test(facts, effective))) {
          return { ...NOT_STRUCTURED, verdict: "error" as const };
        }
        const clean =
          effective === "interaction.completed" &&
          (facts & interactionObject) !== BigInt(0) &&
          (facts & (interactionCompleted | interactionRequiresAction)) !== BigInt(0) &&
          (facts & usageObject) !== BigInt(0) &&
          (facts & inputTokens) !== BigInt(0) &&
          (facts & outputTokens) !== BigInt(0) &&
          (facts & invalidOptionalCounters) === BigInt(0);
        const incomplete =
          (facts & interactionObject) !== BigInt(0) &&
          (facts & interactionIncomplete) !== BigInt(0);
        if (effective === "interaction.completed" || effective === "interaction.incomplete") {
          return {
            ...NOT_STRUCTURED,
            verdict: clean || incomplete ? ("terminal" as const) : ("malformed" as const),
            acceptTerminal: clean || incomplete,
            interactionsCompleted: clean,
          };
        }
        if (effective === "interaction.status_update" && (facts & statusIncomplete) !== BigInt(0)) {
          return { ...NOT_STRUCTURED, verdict: "terminal" as const, acceptTerminal: true };
        }
        if (
          (effective === "step.delta" || effective === "step.start") &&
          ((facts & stepIndex) === BigInt(0) ||
            (effective === "step.delta"
              ? (facts & deltaObject) === BigInt(0) || (facts & deltaType) === BigInt(0)
              : (facts & stepObject) === BigInt(0) || (facts & stepType) === BigInt(0)))
        ) {
          return { ...NOT_STRUCTURED, verdict: "malformed" as const };
        }
        return { ...NOT_STRUCTURED, verdict: classifyRules(facts, effective, rules) };
      }
      let verdict = classifyRules(facts, effective, rules);
      if (verdict === "neutral" && wrappedRules && (facts & responseObject) !== BigInt(0)) {
        const wrappedEvent =
          event || wrapEventQueries.find(([, bit]) => (facts & bit) !== BigInt(0))?.[0] || "";
        verdict = classifyRules(facts, wrappedEvent, wrappedRules);
      }
      const cleanType =
        ((!event || event === "response.completed") && (facts & completedType) !== BigInt(0)) ||
        ((!event || event === "response.done") && (facts & doneType) !== BigInt(0));
      const clean =
        cleanType &&
        (facts & completedStatus) !== BigInt(0) &&
        (facts & responseError) === BigInt(0);
      const incomplete =
        (!event || event === "response.incomplete") &&
        (facts & incompleteType) !== BigInt(0) &&
        (facts & incompleteStatus) !== BigInt(0);
      return {
        verdict,
        acceptTerminal: family === "openai-responses" && (clean || incomplete),
        interactionsCompleted: false,
        toolCallOpen: toolCallOpen.some((test) => test(facts, effective)),
        toolCallClose: toolCallClose.some((test) => test(facts, effective)),
      };
    },
  };
}

const programs = new Map<ProtocolFamily, ReturnType<typeof compile>>();
export function createFrameProbe(
  family: ProtocolFamily,
  reserveDepth?: (bytes: number) => void,
  interactionsCompleted = false
) {
  let program = programs.get(family);
  if (!program) {
    program = compile(family);
    programs.set(family, program);
  }
  const parser = new JsonProbe(program.spec, reserveDepth);
  let empty = true;
  const sentinel =
    family === "gemini-interactions" ? "[DONE]" : STREAM_SIGNALS[family].doneSentinel;
  let sentinelIndex = 0;
  let sentinelValid = Boolean(sentinel);
  return {
    feed: (text: string) => {
      if (text.trim() !== "") empty = false;
      if (sentinelValid && sentinel) {
        for (const c of text) {
          if ((sentinelIndex === 0 || sentinelIndex === sentinel.length) && c.trim() === "")
            continue;
          if (c !== sentinel[sentinelIndex++]) {
            sentinelValid = false;
            break;
          }
        }
      }
      parser.feed(text);
    },
    finish: (event: string | null, head: string, length: number) => {
      if (empty) return { ...NOT_STRUCTURED, verdict: "neutral" as const };
      if (sentinelValid && sentinelIndex === sentinel?.length) {
        if (family === "gemini-interactions") {
          const effective = (event ?? "").trim();
          return {
            ...NOT_STRUCTURED,
            verdict:
              interactionsCompleted &&
              (effective === "" || effective === "message" || effective === "done")
                ? ("neutral" as const)
                : ("malformed" as const),
          };
        }
        return { ...NOT_STRUCTURED, verdict: "terminal" as const };
      }
      return program.evaluate(parser, event, head, length);
    },
  };
}
