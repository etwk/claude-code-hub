import type { SpecialSetting } from "@/types/special-settings";

/** Preserve the public effort field for both canonical and historical usage-log records. */
export function extractAnthropicEffortFromSpecialSettings(
  specialSettings: SpecialSetting[] | null | undefined
): string | null {
  if (!Array.isArray(specialSettings)) return null;

  for (const setting of specialSettings) {
    if (
      setting?.type !== "native_thinking" ||
      setting.protocol !== "anthropic" ||
      setting.hit === false
    ) {
      continue;
    }
    const effort = setting.config?.effort;
    return typeof effort === "string" && effort.trim().length > 0 ? effort : null;
  }

  for (const setting of specialSettings) {
    if (setting?.type !== "anthropic_effort") continue;
    if (typeof setting.effort === "string" && setting.effort.trim().length > 0) {
      return setting.effort.trim();
    }
  }
  return null;
}
