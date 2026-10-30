import { languages, type Locale } from './languages.ts';
import { messageRows } from './messages.ts';
import { detailRows } from './details.ts';
import { onboardingRows } from './onboarding.ts';
import { accessibilityRows } from './accessibility.ts';
import { errorRows } from './errors.ts';
import { noticeRows } from './notices.ts';
import { connectionRows } from './connection.ts';
export const messages = new Map([...messageRows, ...detailRows, ...onboardingRows, ...accessibilityRows, ...errorRows, ...noticeRows, ...connectionRows].map(row => {
  const cells = row.split('|');
  if (cells.length !== languages.length) throw new Error(`Invalid translation row: ${cells[0]}`);
  return [cells[0], cells] as const;
}));
const regions = new Map<string, string>();
const englishRegions = new Intl.DisplayNames(['en-GB'], { type: 'region' });
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  const code = String.fromCharCode(a, b), name = englishRegions.of(code);
  if (name && name !== code) regions.set(name, code);
}
const regionNames = new Map<Locale, Intl.DisplayNames>();
const aliases: Record<string, string> = { 'Privacy policy': 'Privacy Policy', 'Loading locations…': 'Loading locations', 'Connecting…': 'Connecting', 'Disconnecting…': 'Disconnecting' };
export function translate(locale: Locale, value: string): string {
  const index = languages.findIndex(language => language.locale === locale);
  if (index <= 0) return value;
  if (locale === 'pl-PL') {
    const count = /^(\d+) (devices?|locations?)$/.exec(value);
    if (count) {
      const category = new Intl.PluralRules(locale).select(Number(count[1]));
      const forms = count[2].startsWith('device') ? { one: 'urządzenie', few: 'urządzenia', many: 'urządzeń', other: 'urządzenia' } : { one: 'lokalizacja', few: 'lokalizacje', many: 'lokalizacji', other: 'lokalizacji' };
      return `${count[1]} ${forms[category as keyof typeof forms] || forms.other}`;
    }
  }
  const direct = messages.get(value);
  if (direct) return direct[index];
  if (aliases[value]) return translate(locale, aliases[value]) + (value.endsWith('…') ? '…' : '');
  const region = regions.get(value);
  if (region) { if (!regionNames.has(locale)) regionNames.set(locale, new Intl.DisplayNames([locale], { type: 'region' })); return regionNames.get(locale)!.of(region) || value; }
  if (value.endsWith(' ↗')) return translate(locale, value.slice(0, -2)) + ' ↗';
  const trimmed = value.trim();
  if (trimmed !== value && messages.has(trimmed)) return value.replace(trimmed, messages.get(trimmed)![index]);
  // Interpolated UI messages are translated without touching identifiers, account numbers or input values.
  for (const [source, cells] of messages) {
    if (!source.includes('{value}')) continue;
    const [before, after] = source.split('{value}');
    if (value.startsWith(before) && value.endsWith(after) && value.length >= before.length + after.length) {
      return cells[index].replace('{value}', value.slice(before.length, after ? -after.length : undefined));
    }
  }
  if (value.endsWith('…')) return translate(locale, value.slice(0, -1)) + '…';
  return value;
}
