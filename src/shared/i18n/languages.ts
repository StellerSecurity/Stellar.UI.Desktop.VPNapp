export const languages = [
  { name: 'English', locale: 'en-GB', flag: '🇬🇧' },
  { name: 'Dansk', locale: 'da-DK', flag: '🇩🇰' },
  { name: 'Deutsch', locale: 'de-DE', flag: '🇩🇪' },
  { name: 'Türkçe', locale: 'tr-TR', flag: '🇹🇷' },
  { name: 'Español', locale: 'es-ES', flag: '🇪🇸' },
  { name: 'Svenska', locale: 'sv-SE', flag: '🇸🇪' },
  { name: 'Norsk (bokmål)', locale: 'nb-NO', flag: '🇳🇴' },
  { name: 'Français', locale: 'fr-FR', flag: '🇫🇷' },
  { name: 'Italiano', locale: 'it-IT', flag: '🇮🇹' },
  { name: 'Nederlands', locale: 'nl-NL', flag: '🇳🇱' },
  { name: 'Polski', locale: 'pl-PL', flag: '🇵🇱' },
  { name: 'Português (Brasil)', locale: 'pt-BR', flag: '🇧🇷' },
] as const;
export type Locale = typeof languages[number]['locale'];
export function searchLanguages(query: string, label: (name: string) => string = name => name) {
  const normalize = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
  const needle = normalize(query);
  return languages.filter(language => normalize(`${language.name} ${label(language.name)} ${language.locale}`).includes(needle));
}
export function resolveLanguage(value: string) {
  return languages.find(language => language.name === value || language.locale === value) || languages[0];
}
