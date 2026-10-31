import { normalizeEndpointPath, V1_ENDPOINT_PATHS } from "./endpoint-paths";
import { ProxyResponses } from "./responses";
import type { ProxySession } from "./session";

/**
 * Require a model for rerank and System One scheduling, then enforce user model restrictions.
 * Other endpoints retain their existing optional-model behavior when unrestricted.
 * User allowlists use case-insensitive exact matching.
 */
export class ProxyModelGuard {
  static async ensure(session: ProxySession): Promise<Response | null> {
    const user = session.authState?.user;
    if (!user) {
      // No user context - skip check (authentication should have failed already)
      return null;
    }

    const normalizedPath = normalizeEndpointPath(session.requestUrl.pathname);
    if (
      normalizedPath === V1_ENDPOINT_PATHS.RERANK ||
      normalizedPath === V1_ENDPOINT_PATHS.SYSTEMONE
    ) {
      const model = session.request.message.model;
      if (typeof model !== "string" || model.trim() === "") {
        return ProxyResponses.buildError(400, "model is required", "invalid_request_error");
      }
    }

    // Check if model restrictions are configured
    const allowedModels = user.allowedModels ?? [];
    if (allowedModels.length === 0) {
      // No restrictions configured - skip all checks
      return null;
    }

    // Restrictions exist - now model is required
    const requestedModel = session.getOriginalModel();

    // Missing or null model when restrictions exist
    if (!requestedModel || requestedModel.trim() === "") {
      return ProxyResponses.buildError(
        400,
        "Model not allowed. Model specification is required when model restrictions are configured.",
        "invalid_request_error"
      );
    }

    // Case-insensitive exact match
    const requestedModelLower = requestedModel.toLowerCase();
    const isAllowed = allowedModels.some(
      (pattern) => pattern.toLowerCase() === requestedModelLower
    );

    if (!isAllowed) {
      return ProxyResponses.buildError(
        400,
        `Model not allowed. The requested model '${requestedModel}' is not in the allowed list.`,
        "invalid_request_error"
      );
    }

    // Model is allowed
    return null;
  }
}
