/**
 * Model tiers shared by the tool delegation, the settings page and the
 * OpenAI-compatible provider.
 *
 * A "tier" is the tool's name for a model+thinking-level pair (`argon-4-lo`).
 * `agy` itself takes model ids (`gemini-4-argon-low`), so the two need a
 * mapping. Keeping it in one place stops the three call sites drifting.
 */

export interface TierGroup {
  /** Display name of the model family. */
  model: string;
  tiers: ReadonlyArray<{ tier: string; level: string }>;
}

export const TIER_GROUPS: ReadonlyArray<TierGroup> = [
  {
    model: "Gemini 4 Argon",
    tiers: [
      { tier: "argon-4-lo", level: "Low" },
      { tier: "argon-4-med", level: "Medium" },
      { tier: "argon-4-hi", level: "High" },
    ],
  },
  {
    model: "Gemini 3.8 Flash",
    tiers: [
      { tier: "flash-3.8-lo", level: "Low" },
      { tier: "flash-3.8-med", level: "Medium" },
      { tier: "flash-3.8-hi", level: "High" },
    ],
  },
  {
    model: "Claude Sonnet 5.5",
    tiers: [
      { tier: "claude-sonnet-5-5-lo", level: "Low" },
      { tier: "claude-sonnet-5-5-med", level: "Medium" },
      { tier: "claude-sonnet-5-5-hi", level: "High" },
    ],
  },
  {
    model: "Claude Opus 5.5",
    tiers: [
      { tier: "claude-opus-5-5-lo", level: "Low" },
      { tier: "claude-opus-5-5-med", level: "Medium" },
      { tier: "claude-opus-5-5-hi", level: "High" },
    ],
  },
  {
    model: "GPT-OSS 120B",
    tiers: [{ tier: "gpt-oss-med", level: "Medium" }],
  },
];

/** `argon-4-lo` → `Gemini 4 Argon (Low)` */
export const TIER_LABEL: Record<string, string> = Object.fromEntries(
  TIER_GROUPS.flatMap((g) => g.tiers.map((t) => [t.tier, `${g.model} (${t.level})`])),
);

export const ALL_TIERS: string[] = Object.keys(TIER_LABEL);

/** `gemini-4-argon-low` (agy id) → `argon-4-lo` (tier). */
export const MODEL_TO_TIER: Record<string, string> = {
  "gemini-4-argon-low": "argon-4-lo",
  "gemini-4-argon-medium": "argon-4-med",
  "gemini-4-argon-high": "argon-4-hi",
  "gemini-3.8-flash-low": "flash-3.8-lo",
  "gemini-3.8-flash-medium": "flash-3.8-med",
  "gemini-3.8-flash-high": "flash-3.8-hi",
  "claude-sonnet-5-5-low": "claude-sonnet-5-5-lo",
  "claude-sonnet-5-5-medium": "claude-sonnet-5-5-med",
  "claude-sonnet-5-5-high": "claude-sonnet-5-5-hi",
  "claude-opus-5-5-low": "claude-opus-5-5-lo",
  "claude-opus-5-5-medium": "claude-opus-5-5-med",
  "claude-opus-5-5-high": "claude-opus-5-5-hi",
  "gpt-oss-120b-medium": "gpt-oss-med",
};

/** Which tiers an account may use, given the model ids `agy models` returned. */
export function allowedTiers(models: string[] | undefined): Set<string> | null {
  if (!models || models.length === 0) return null;
  const set = new Set(models.map((m) => MODEL_TO_TIER[m]).filter(Boolean));
  return set.size > 0 ? set : null;
}
