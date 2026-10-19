"use client";

import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { ThinkingEffortBadge } from "@/components/customs/thinking-effort-badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { extractThinkingEffortInfo, type ThinkingEffortInfo } from "@/lib/utils/thinking-effort";
import type { SpecialSetting, ThinkingConfigValue } from "@/types/special-settings";

type ThinkingTranslations = (key: string, values?: { count: number }) => string;

/** Describe recorded values only; a missing setting never implies a model default. */
function describeThinkingConfig(
  config: ThinkingConfigValue | null,
  source: ThinkingEffortInfo["source"],
  t: ThinkingTranslations
) {
  if (!config) return null;

  const mode = config.mode ? t(`modes.${config.mode}`) : null;
  const budget =
    config.budgetTokens === null
      ? null
      : source === "gemini" && config.budgetTokens === -1
        ? `${t("dynamic")} (-1)`
        : source === "gemini" && config.budgetTokens === 0
          ? `${t("modes.disabled")} (0)`
          : t("budgetTokens", { count: config.budgetTokens });
  const disabled = config.mode === "disabled" || (source === "gemini" && config.budgetTokens === 0);
  const compact = disabled ? t("modes.disabled") : (config.effort ?? budget ?? mode ?? "");
  const description = [
    mode === null ? null : `${t("mode")}: ${mode}`,
    config.effort === null ? null : `${t("effort")}: ${config.effort}`,
    budget === null ? null : `${t("budget")}: ${budget}`,
  ]
    .filter((value) => value !== null)
    .join(" · ");

  return {
    compact,
    description,
    // Disabled modes take precedence over any stale effort when choosing a badge style, too.
    badgeEffort: disabled ? "none" : (config.effort ?? config.mode ?? "budget"),
  };
}

/** Full recorded configuration, shared by list tooltips and request details. */
export function ThinkingEffortDetails({ info }: { info: ThinkingEffortInfo }) {
  const t = useTranslations("dashboard.logs.details.thinkingConfig");
  const requested = describeThinkingConfig(info.requested, info.source, t);
  const effective = describeThinkingConfig(info.effective, info.source, t);

  return (
    <div className="space-y-2 text-xs" data-slot="thinking-config-details">
      <p className="font-medium">{t("label")}</p>
      <p className="font-sans">{t(`tooltips.${info.source}`)}</p>
      <dl className="space-y-1">
        <div data-slot="thinking-config-requested">
          <dt className="font-medium">{t("requested")}</dt>
          <dd className="break-words font-mono">{requested?.description || t("notSpecified")}</dd>
        </div>
        {(info.isOverridden || (!requested && effective)) && (
          <div data-slot="thinking-config-effective">
            <dt className="font-medium">{t("effective")}</dt>
            <dd className="break-words font-mono">{effective?.description || t("removed")}</dd>
          </div>
        )}
      </dl>
      {info.isOverridden && <p className="font-sans">{t("overridden")}</p>}
    </div>
  );
}

/** Width-bounded summary with keyboard-accessible, complete original/forwarded values. */
export function ThinkingEffortDisplay({
  specialSettings,
}: {
  specialSettings: SpecialSetting[] | null | undefined;
}) {
  const t = useTranslations("dashboard.logs.details.thinkingConfig");
  const info = extractThinkingEffortInfo(specialSettings);

  if (!info) {
    return <span className="text-muted-foreground">-</span>;
  }

  const requested = describeThinkingConfig(info.requested, info.source, t);
  const effective = describeThinkingConfig(info.effective, info.source, t);
  const current = effective ?? requested;
  const accessibleLabel = info.isOverridden
    ? `${t("requested")}: ${requested?.description || t("notSpecified")}; ${t("effective")}: ${effective?.description || t("removed")}`
    : `${t("label")}: ${current?.description || t("notSpecified")}`;

  return (
    <TooltipProvider>
      <Tooltip delayDuration={250}>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={accessibleLabel}
            className="block w-full min-w-0 overflow-hidden rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-slot="thinking-effort"
          >
            <ThinkingEffortBadge
              effort={(info.isOverridden ? requested : current)?.badgeEffort ?? "unknown"}
              label={(info.isOverridden ? requested : current)?.compact || t("notSpecified")}
              className="block max-w-full truncate"
            />
            {info.isOverridden && (
              <span className="flex min-w-0 items-center gap-1">
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                <ThinkingEffortBadge
                  effort={effective?.badgeEffort ?? "unknown"}
                  label={effective?.compact || t("removed")}
                  className="block min-w-0 max-w-full shrink truncate"
                />
              </span>
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm">
          <ThinkingEffortDetails info={info} />
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
