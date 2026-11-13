import { resolveEndpointFamilyByPath } from "../proxy/endpoint-family-catalog";

// These resource names belong to the native Gemini protocol, not OpenAI model IDs.
const GEMINI_MODEL_RESOURCE =
  /^(?:(?:projects\/[^/]+\/locations\/[^/]+\/)?publishers\/[^/]+\/)?models\/([^/:]+)$/;
const GEMINI_MODEL_PATH =
  /^(\/v1(?:beta|internal)?\/(?:projects\/[^/]+\/locations\/[^/]+\/)?(?:publishers\/[^/]+\/)?models\/)([^/:]+)(:[^/]+)?(\/)?$/i;

function matchGeminiModelPath(pathname: string): RegExpExecArray | null {
  const match = GEMINI_MODEL_PATH.exec(pathname);
  // /v1/models/{id} without an action belongs to OpenAI, whose IDs are opaque.
  if (match && !match[3] && resolveEndpointFamilyByPath(pathname)?.surface === "openai") {
    return null;
  }
  return match;
}

/** Return the routing identity shared by a bare ID and a native model resource. */
export function normalizeGeminiModelName(model: string): string {
  return GEMINI_MODEL_RESOURCE.exec(model)?.[1] ?? model;
}

function validateGeminiModelPathSegment(model: string): string {
  if (/[\s/:]/.test(model) || model === "." || model === "..") {
    throw new URIError("Invalid Gemini model path segment");
  }
  return model;
}

/**
 * Decode only the URI model segment, never JSON model/resource identifiers.
 * Throws URIError for malformed encoding or IDs that cannot occupy one model segment.
 */
export function extractGeminiModelFromPath(pathname: string): string | null {
  const match = matchGeminiModelPath(pathname);
  return match ? validateGeminiModelPathSegment(decodeURIComponent(match[2])) : null;
}

/** Endpoint actions are case-insensitive in the catalog; model IDs are not. */
export function getGeminiModelAction(pathname: string): string | null {
  return matchGeminiModelPath(pathname)?.[3]?.slice(1).toLowerCase() ?? null;
}

export function isNativeGeminiModelPath(pathname: string): boolean {
  return matchGeminiModelPath(pathname) !== null;
}

/** Keep endpoint spelling and unchanged model encoding; encode new IDs as one segment. */
export function rewriteGeminiModelPath(pathname: string, model: string): string {
  const match = matchGeminiModelPath(pathname);
  if (!match) return pathname;
  const source = validateGeminiModelPathSegment(decodeURIComponent(match[2]));
  const target = validateGeminiModelPathSegment(normalizeGeminiModelName(model));
  if (source === target) return pathname;
  // Encode reserved URL characters without interpreting literal percent sequences.
  const encodedTarget = encodeURI(target).replace(/[/?#:]/g, (character) =>
    encodeURIComponent(character)
  );
  return `${match[1]}${encodedTarget}${match[3] ?? ""}${match[4] ?? ""}`;
}

function rewriteModelField(record: Record<string, unknown>, model: string): boolean {
  if (typeof record.model !== "string") return false;
  if (normalizeGeminiModelName(record.model) === model) return false;
  const resource = GEMINI_MODEL_RESOURCE.exec(record.model);
  const rewritten = resource
    ? `${record.model.slice(0, record.model.length - resource[1].length)}${model}`
    : model;
  record.model = rewritten;
  return true;
}

/**
 * Rewrite only native protocol model fields that already exist. In particular,
 * never add a top-level model to path-only requests or traverse user content.
 */
export function rewriteGeminiRequestModels(
  message: Record<string, unknown>,
  model: string,
  pathname: string
): boolean {
  if (!isNativeGeminiModelPath(pathname)) return false;
  const target = normalizeGeminiModelName(model);
  let changed = rewriteModelField(message, target);
  const action = getGeminiModelAction(pathname);
  if (action === "batchembedcontents" && Array.isArray(message.requests)) {
    for (const request of message.requests) {
      if (typeof request === "object" && request !== null && !Array.isArray(request)) {
        changed = rewriteModelField(request as Record<string, unknown>, target) || changed;
      }
    }
  }
  const contentRequest = message.generateContentRequest;
  if (
    action === "counttokens" &&
    typeof contentRequest === "object" &&
    contentRequest !== null &&
    !Array.isArray(contentRequest)
  ) {
    changed = rewriteModelField(contentRequest as Record<string, unknown>, target) || changed;
  }
  return changed;
}
