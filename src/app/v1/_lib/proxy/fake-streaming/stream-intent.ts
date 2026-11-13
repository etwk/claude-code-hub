import { getGeminiModelAction } from "@/app/v1/_lib/gemini/model";
import { isSystemOneEndpointPath } from "../endpoint-paths";
import type { ClientFormat } from "../format-mapper";

export interface StreamIntentInputs {
  format: ClientFormat;
  pathname: string;
  search: string;
  body: Record<string, unknown> | null;
}

const GEMINI_FORMATS: ReadonlyArray<ClientFormat> = ["gemini", "gemini-cli"];

function isGeminiFamily(format: ClientFormat): boolean {
  return GEMINI_FORMATS.includes(format);
}

function bodyStreamFlag(body: Record<string, unknown> | null): boolean {
  return body !== null && body.stream === true;
}

/**
 * Detect whether the client requested a streaming response.
 *
 * Standard formats (claude / openai / response): only `body.stream === true`
 * counts. Path / query are ignored.
 *
 * Gemini family (gemini / gemini-cli): any of `:streamGenerateContent` in
 * pathname, `alt=sse` query, or `body.stream === true` counts.
 *
 * Inputs come from already-parsed request state — this helper does not consume
 * request body streams.
 */
export function detectClientStreamIntent(input: StreamIntentInputs): boolean {
  if (isSystemOneEndpointPath(input.pathname)) return false;
  if (isGeminiFamily(input.format)) {
    if (getGeminiModelAction(input.pathname) === "streamgeneratecontent") return true;
    if (hasAltSse(input.search)) return true;
    return bodyStreamFlag(input.body);
  }
  return bodyStreamFlag(input.body);
}

function hasAltSse(search: string): boolean {
  if (!search) return false;
  // search may or may not include leading "?"; URLSearchParams handles both.
  const normalized = search.startsWith("?") ? search.slice(1) : search;
  if (!normalized) return false;
  try {
    const params = new URLSearchParams(normalized);
    // `alt` may legally appear multiple times (e.g. ?alt=json&alt=sse). Only
    // looking at the first value would misclassify such requests as
    // non-streaming.
    return params.getAll("alt").includes("sse");
  } catch {
    return false;
  }
}

/** Mutate only the streaming field; return the corresponding URL transport mode. */
export function applyNonStreamRequestMode(input: StreamIntentInputs): StreamIntentInputs {
  const gemini = isGeminiFamily(input.format);
  if (input.body !== null && (!gemini || "stream" in input.body)) input.body.stream = false;
  return {
    ...input,
    pathname:
      gemini && getGeminiModelAction(input.pathname) === "streamgeneratecontent"
        ? input.pathname.replace(/:streamGenerateContent(\/?)$/i, ":generateContent$1")
        : input.pathname,
    search: gemini ? stripAltSse(input.search) : input.search,
  };
}

function stripAltSse(search: string): string {
  if (!search) return "";
  const hasLeadingQuestion = search.startsWith("?");
  const raw = hasLeadingQuestion ? search.slice(1) : search;
  if (!raw) return "";
  try {
    const params = new URLSearchParams(raw);
    const altValues = params.getAll("alt");
    if (altValues.includes("sse")) {
      // Drop only the sse occurrences; preserve any other `alt` values.
      params.delete("alt");
      for (const value of altValues) {
        if (value !== "sse") params.append("alt", value);
      }
    }
    const remaining = params.toString();
    if (!remaining) return "";
    return hasLeadingQuestion ? `?${remaining}` : remaining;
  } catch {
    return search;
  }
}
