/**
 * Translating what people wrote (docs/translate.md): one feature, several providers. A network that translates its
 * own posts (X: the "Translate post" under a post, capability 'translate') is one provider; a translation server the
 * owner runs (any LibreTranslate-compatible URL: LibreTranslate, or a local model behind the same API) is another. The
 * hub picks one per text, caches what it got, and the page shows it under the original or in its place.
 */
import type { Network } from './ontology.ts';

/** Who translates. 'network': the network's own, for its posts, falling back to the server where it cannot. */
export type TranslateProvider = 'network' | 'server';

export interface TranslateSettings {
  /** Translate a post written in another language without asking, where a provider can. */
  auto: boolean;
  /** Into this language (a BCP 47 tag's language: 'en', 'ja', 'pt'). */
  to: string;
  /** Shown under the original ('below'), or in its place with a way back ('replace'). */
  show: 'below' | 'replace';
  provider: TranslateProvider;
  /** A LibreTranslate-compatible server (POST <url>/translate). Null: none. */
  serverUrl: string | null;
}
export const TRANSLATE_DEFAULTS: TranslateSettings = { auto: true, to: 'en', show: 'below', provider: 'network', serverUrl: null };

/** One text to translate: `key` names it in the answer; a post gives its network and id, so the network can do it. */
export interface TranslateItem {
  key: string;
  text: string;
  /** The language the network says it is in (X: legacy.lang), when it says. */
  lang?: string;
  network?: Network;
  post?: string;
}

export interface Translation {
  key: string;
  text: string;
  /** The language it was in, as the provider saw it. */
  from?: string;
  /** Who translated it, in words: "X", "Google via X", "LibreTranslate". */
  by: string;
}

/** POST /api/translate's answer. */
export interface TranslateResult {
  translations: Translation[];
  /** Those that could not be, and why in words. */
  failed: { key: string; why: string }[];
}

/** What a network answers `translate` with (capability 'translate'). */
export interface NetworkTranslation {
  text: string;
  from?: string;
  by?: string;
}

/** Language tags that are no language: undetermined, no linguistic content, media or hashtags only (X's q* codes). */
const NO_LANGUAGE = new Set(['und', 'zxx', 'qme', 'qam', 'qct', 'qht', 'qst', 'art', 'mis']);
const base = (tag: string) => tag.toLowerCase().split(/[-_]/)[0]!;

/** Worth translating into `to`: its language is known, is a language, and is not `to`'s. */
export function needsTranslation(lang: string | undefined | null, to: string): boolean {
  if (!lang) return false;
  const l = base(lang);
  return !!l && !NO_LANGUAGE.has(l) && l !== base(to);
}

/** A language's name in English, for "Translated from Japanese" ('ja' → 'Japanese'); the tag itself when unknown. */
export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(base(tag)) ?? tag;
  } catch {
    return tag;
  }
}

/** The languages offered to translate into (Settings), most used first. */
export const TRANSLATE_TARGETS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'ko', 'zh', 'ru', 'uk', 'pl', 'tr', 'ar', 'hi', 'id', 'vi', 'th', 'sv'] as const;
