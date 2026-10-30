import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { resolveLanguage, type Locale } from './languages';
import { translate } from './translate';
const LocaleContext = createContext<Locale>('en-GB');
export function I18nProvider({ language, children }: { language: string; children: ReactNode }) {
  const locale = resolveLanguage(language).locale;
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}
export const useLocale = () => useContext(LocaleContext);
export function useTranslation() {
  const locale = useLocale();
  return useMemo(() => <T,>(value: T): T => typeof value === 'string' ? translate(locale, value) as T : value, [locale]);
}
