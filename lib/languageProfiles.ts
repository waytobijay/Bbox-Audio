/**
 * Per-language synthesis profiles.
 *
 * A language without a profile behaves exactly as it always has: the tuned
 * defaults, the multilingual Chatterbox model, and the language code passed
 * straight through. Profiles exist so a language that needs *different*
 * treatment — a different engine, gentler pacing — can get it without the
 * synthesis path growing a special case per language.
 *
 * Resolution order, strongest first:
 *   1. the request's own params
 *   2. the voice's stored overrides
 *   3. the language profile
 *   4. the tuned defaults
 */

import { DEFAULT_PARAMS } from "./config";

/** What a model is actually asked to do. */
export interface EngineSettings {
  engine: string;
  /** The code handed to the model, which may differ from the UI language. */
  modelLanguage: string;
  exaggeration: number;
  cfg: number;
  temperature: number;
}

/** Fields a caller or a voice may override. All optional. */
export interface SynthOverrides {
  engine?: string;
  exaggeration?: number;
  cfg?: number;
  temperature?: number;
}

export interface LanguageProfile {
  label: string;
  engine: string;
  exaggeration?: number;
  cfg?: number;
  temperature?: number;
  /**
   * Used when the primary engine cannot be loaded. The backend decides this —
   * it is the only place that knows whether a model actually came up — and
   * reports which one it used as `engine_used`.
   */
  fallback?: Partial<EngineSettings> & { engine: string; modelLanguage: string };
}

/** The engine every language has always used. */
export const DEFAULT_ENGINE = "chatterbox-mtl";

export const LANGUAGE_PROFILES: Record<string, LanguageProfile> = {
  ne: {
    label: "Nepali",
    // A Nepali-specific model. The backend resolves this to a real checkpoint
    // only if one is configured; otherwise it reports the fallback, because a
    // silent wrong-language render is worse than an honest substitution.
    engine: "chatterbox-ne",
    exaggeration: 0.5,
    cfg: 0.5,
    temperature: 0.8,
    // Hindi shares Devanagari and is one of Chatterbox's 23 languages. The
    // pacing is deliberately slower and flatter than Hindi's own default:
    // Nepali read with Hindi prosody rushes, and dropping cfg lets it breathe.
    fallback: {
      engine: DEFAULT_ENGINE,
      modelLanguage: "hi",
      cfg: 0.3,
      exaggeration: 0.4,
    },
  },
};

export function profileFor(language?: string | null): LanguageProfile | null {
  if (!language) return null;
  return LANGUAGE_PROFILES[language.toLowerCase()] ?? null;
}

/** Languages that need a model the stock multilingual checkpoint doesn't have. */
export function needsOwnEngine(language?: string | null): boolean {
  const p = profileFor(language);
  return !!p && p.engine !== DEFAULT_ENGINE;
}

/**
 * Work out what to ask the model for.
 *
 * `language` is the voice's language unless the request overrode it. Anything
 * left undefined at every level falls through to the tuned defaults, so an
 * English request produces byte-identical settings to before profiles existed.
 */
export function resolveSynthesis(args: {
  language?: string | null;
  voice?: SynthOverrides | null;
  request?: SynthOverrides | null;
}): EngineSettings & { fallback?: LanguageProfile["fallback"] } {
  const { language, voice, request } = args;
  const profile = profileFor(language);

  const pick = <K extends keyof SynthOverrides>(key: K, fallbackValue: number): number => {
    const v = request?.[key] ?? voice?.[key] ?? profile?.[key as "exaggeration" | "cfg" | "temperature"];
    return typeof v === "number" ? v : fallbackValue;
  };

  const engine =
    request?.engine ?? voice?.engine ?? profile?.engine ?? DEFAULT_ENGINE;

  return {
    engine,
    // The model is told the real language code. Substituting one for another
    // is the fallback's job, on the backend, where it is also reported.
    modelLanguage: language || "en",
    exaggeration: pick("exaggeration", DEFAULT_PARAMS.exaggeration),
    cfg: pick("cfg", DEFAULT_PARAMS.cfg),
    temperature: pick("temperature", DEFAULT_PARAMS.temperature),
    ...(profile?.fallback ? { fallback: profile.fallback } : {}),
  };
}
