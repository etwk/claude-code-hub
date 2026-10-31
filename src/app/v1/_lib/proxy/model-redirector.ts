import { logger } from "@/lib/logger";
import {
  findMatchingProviderModelRedirectRule,
  getProviderModelRedirectTarget,
  hasProviderModelRedirectRules,
  resolveProviderModelRedirectTarget,
} from "@/lib/provider-model-redirects";
import type { Provider } from "@/types/provider";
import {
  isNativeGeminiModelPath,
  normalizeGeminiModelName,
  rewriteGeminiModelPath,
  rewriteGeminiRequestModels,
} from "../gemini/model";
import { isOpenAIImageMultipartRequest, setOpenAIImageMultipartModel } from "./openai-image-compat";
import { rewriteRawJsonModel } from "./raw-json-model";
import type { ProxySession } from "./session";

/**
 * 模型重定向器
 *
 * 根据供应商配置的 modelRedirects 重写请求中的模型名称
 * 例如：将 Claude Code 客户端请求的 "claude-sonnet-4-5-20250929" 重定向为上游供应商支持的 "glm-4.6"
 * 用于接入第三方 AI 服务或成本优化
 */
export class ModelRedirector {
  /**
   * 应用模型重定向（如果配置了）
   *
   * @param session - 代理会话
   * @param provider - 目标供应商
   * @returns 是否进行了重定向
   */
  static apply(
    session: ProxySession,
    provider: Provider,
    routingModel: string | null = session.getRoutingModel()
  ): boolean {
    // Provider attempts match the global routing identity (or their explicit
    // provider-filter input), never a previous provider's redirected target.
    const nativeGemini = isNativeGeminiModelPath(session.requestUrl.pathname);
    const originalModel =
      routingModel && nativeGemini ? normalizeGeminiModelName(routingModel) : routingModel;

    // 检查是否配置了模型重定向
    if (!hasProviderModelRedirectRules(provider.modelRedirects)) {
      session.clearCurrentModelRedirect();
      // 如果新供应商没有重定向配置，且之前发生过重定向，需要重置
      if (originalModel && session.request.model !== originalModel) {
        ModelRedirector.resetToOriginal(session, originalModel, provider);
      }
      return false;
    }

    if (!originalModel) {
      logger.debug("[ModelRedirector] No model in request, skipping redirect", {
        providerId: provider.id,
        providerName: provider.name,
      });
      return false;
    }

    // 检查是否有该模型的重定向配置
    const matchedRule = findMatchingProviderModelRedirectRule(
      originalModel,
      provider.modelRedirects
    );
    if (!matchedRule) {
      session.clearCurrentModelRedirect();
      // 如果新供应商对此模型没有重定向规则，且之前发生过重定向，需要重置
      if (session.request.model !== originalModel) {
        ModelRedirector.resetToOriginal(session, originalModel, provider);
      } else {
        logger.debug("[ModelRedirector] No redirect configured for model", {
          model: originalModel,
          providerId: provider.id,
          providerName: provider.name,
        });
      }
      return false;
    }

    const resolvedTarget = resolveProviderModelRedirectTarget(originalModel, matchedRule);
    const redirectedModel = nativeGemini
      ? normalizeGeminiModelName(resolvedTarget)
      : resolvedTarget;

    // 执行重定向
    logger.info("[ModelRedirector] Model redirected", {
      originalModel,
      redirectedModel,
      matchType: matchedRule.matchType,
      matchedSource: matchedRule.source,
      providerId: provider.id,
      providerName: provider.name,
      providerType: provider.providerType,
    });

    // The immutable client identity remains the billing/audit identity even
    // when administrator filters changed the model used to match this rule.
    const clientModel = session.getOriginalModel() ?? originalModel;
    session.setOriginalModel(clientModel);
    ModelRedirector.setRequestModel(session, redirectedModel);

    // 更新日志（记录重定向）
    session.request.note = `[Model Redirected: ${originalModel} → ${redirectedModel}] ${session.request.note || ""}`;

    const redirectInfo = {
      originalModel: clientModel,
      redirectedModel,
      billingModel: clientModel,
      matchedRule: {
        matchType: matchedRule.matchType,
        source: matchedRule.source,
        target: matchedRule.target,
      },
    } as const;

    // 记录当前 attempt 的 redirect 快照。
    // 如果最后一条链路项本来就属于当前 provider（例如 initial_selection），顺手更新它；
    // 否则保留快照，等待后续 hedge_winner / retry_failed 等真正属于该 provider 的链路项来消费。
    session.setCurrentModelRedirect(provider.id, redirectInfo);
    session.attachCurrentModelRedirectToLastChainItem(provider.id);
    logger.debug("[ModelRedirector] Recorded modelRedirect for current provider attempt", {
      providerId: provider.id,
      originalModel,
      redirectedModel,
    });

    return true;
  }

  /**
   * 获取重定向后的模型名称（不修改 session）
   *
   * @param originalModel - 原始模型名称
   * @param provider - 供应商
   * @returns 重定向后的模型名称（如果没有重定向则返回原始名称）
   */
  static getRedirectedModel(originalModel: string, provider: Provider): string {
    if (!provider.modelRedirects || !originalModel) {
      return originalModel;
    }

    return getProviderModelRedirectTarget(originalModel, provider.modelRedirects);
  }

  /**
   * 检查供应商是否配置了指定模型的重定向
   *
   * @param model - 模型名称
   * @param provider - 供应商
   * @returns 是否配置了重定向
   */
  static hasRedirect(model: string, provider: Provider): boolean {
    return !!findMatchingProviderModelRedirectRule(model, provider.modelRedirects);
  }

  /**
   * 重置模型到原始值（用于供应商切换时）
   *
   * @param session - 代理会话
   * @param originalModel - 原始模型名称
   * @param provider - 新供应商
   */
  private static resetToOriginal(
    session: ProxySession,
    originalModel: string,
    provider: Provider
  ): void {
    ModelRedirector.setRequestModel(session, originalModel);

    logger.info("[ModelRedirector] Reset model to original (provider switch)", {
      originalModel,
      providerId: provider.id,
      providerName: provider.name,
    });
  }

  private static setRequestModel(session: ProxySession, model: string): void {
    const pathname = session.requestUrl.pathname;
    const nativeGemini = isNativeGeminiModelPath(pathname);
    const target = nativeGemini ? normalizeGeminiModelName(model) : model;
    const imageRequestMetadata = session.getOpenAIImageRequestMetadata();
    let bodyChanged: boolean;
    if (nativeGemini) {
      bodyChanged = rewriteGeminiRequestModels(session.request.message, target, pathname);
      const newPath = rewriteGeminiModelPath(pathname, target);
      if (newPath !== pathname) {
        const newUrl = new URL(session.requestUrl.toString());
        newUrl.pathname = newPath;
        session.requestUrl = newUrl;
      }
    } else {
      bodyChanged = session.request.message.model !== target;
      if (bodyChanged) session.request.message.model = target;
      if (isOpenAIImageMultipartRequest(imageRequestMetadata) && imageRequestMetadata) {
        setOpenAIImageMultipartModel(imageRequestMetadata, target);
      }
    }
    session.request.model = target;

    // Raw JSON only changes model tokens; preserve every unrelated byte.
    // Multipart bodies belong to their protocol serializer.
    if (
      bodyChanged &&
      !isOpenAIImageMultipartRequest(imageRequestMetadata) &&
      !session.request.systemOneMultipart &&
      !session.request.audioMultipart
    ) {
      session.request.buffer =
        session.getEndpointPolicy().bypassForwarderPreprocessing && session.request.buffer
          ? rewriteRawJsonModel(session.request.buffer, target)
          : new TextEncoder().encode(JSON.stringify(session.request.message)).buffer;
    }
  }
}
