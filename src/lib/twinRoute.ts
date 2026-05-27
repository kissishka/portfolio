import { locales, isLocale, type Locale } from "./t";

const LOCALE_PREFIX = new RegExp(`^/(?:${locales.join("|")})(/|$)`);

export function twinRoute(pathname: string, targetLocale: Locale): string {
  if (!isLocale(targetLocale)) {
    throw new Error(`twinRoute: unknown target locale "${targetLocale}"`);
  }
  if (LOCALE_PREFIX.test(pathname)) {
    return pathname.replace(LOCALE_PREFIX, `/${targetLocale}$1`);
  }
  return `/${targetLocale}/`;
}
