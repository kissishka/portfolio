import en from "../content/i18n/en.json";
import uk from "../content/i18n/uk.json";

export type Locale = "en" | "uk";

const dictionaries: Record<Locale, Record<string, string>> = { en, uk };

export function t(key: string, locale: Locale): string {
  const dict = dictionaries[locale];
  const value = dict[key];
  if (value === undefined) {
    if (import.meta.env.DEV) {
      console.warn(`[i18n] missing key "${key}" for locale "${locale}"`);
    }
    return key;
  }
  return value;
}

export const locales: Locale[] = ["en", "uk"];

export function isLocale(value: string): value is Locale {
  return value === "en" || value === "uk";
}
