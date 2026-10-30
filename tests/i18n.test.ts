import test from 'node:test';
import assert from 'node:assert/strict';
import { languages, resolveLanguage } from '../src/shared/i18n/languages.ts';
import { messages, translate } from '../src/shared/i18n/translate.ts';

test('all twelve languages have complete bundled messages with matching placeholders', () => {
  assert.equal(languages.length, 12);
  assert.equal(new Set(languages.map(language => language.locale)).size, 12);
  assert.ok(messages.size >= 300);
  for (const [source, cells] of messages) {
    assert.equal(cells.length, languages.length, source);
    for (const cell of cells) {
      assert.ok(cell.trim(), source);
      assert.equal((cell.match(/\{value\}/g) || []).length, (source.match(/\{value\}/g) || []).length, source);
    }
  }
});
test('persisted names, locales and unknown preferences resolve safely', () => {
  for (const language of languages) {
    assert.equal(resolveLanguage(language.name).locale, language.locale);
    assert.equal(resolveLanguage(language.locale).name, language.name);
  }
  assert.equal(resolveLanguage('unknown').locale, 'en-GB');
});
test('Stellar ID sign-up copy stays distinct from account-number sign-in', () => {
  assert.equal(translate('da-DK', 'Don’t have a Stellar ID?'), 'Har du ikke et Stellar ID?');
  assert.equal(translate('da-DK', 'Create a Stellar ID'), 'Opret et Stellar ID');
  assert.equal(translate('da-DK', 'Create anonymously'), 'Opret anonymt');
  assert.equal(translate('da-DK', 'Create an anonymous account number'), 'Opret anonymt kontonummer');
  assert.equal(translate('da-DK', 'or'), 'eller');
  assert.equal(translate('da-DK', 'Account number'), 'Kontonummer');
  for (const language of languages) {
    assert.ok(translate(language.locale, 'Create a Stellar ID').includes('Stellar ID'));
  }
});
test('navigation, dynamic counts, countries and notices translate without modifying private values', () => {
  assert.equal(translate('da-DK', 'Settings'), 'Indstillinger');
  assert.equal(translate('da-DK', 'Norway'), 'Norge');
  assert.equal(translate('pt-BR', 'Devices'), 'Dispositivos');
  assert.equal(translate('nb-NO', 'Connecting'), 'Kobler til');
  assert.equal(translate('da-DK', '3 devices'), '3 enheder');
  assert.equal(translate('da-DK', 'Connected to Norway – Oslo.'), 'Forbundet til Norway – Oslo.');
  assert.equal(translate('de-DE', '1234 5678 9012 3456'), '1234 5678 9012 3456');
  assert.equal(translate('tr-TR', 'Connecting…'), 'Bağlanıyor…');
});
test('Spanish is selectable once and dynamic loading messages retain their translations', () => {
  assert.equal(languages.filter(language => language.locale === 'es-ES').length, 1);
  assert.equal(resolveLanguage('Español').locale, 'es-ES');
  assert.equal(translate('es-ES', 'Settings'), 'Ajustes');
  assert.equal(translate('es-ES', 'Cancel connection'), 'Cancelar conexión');
  assert.equal(translate('es-ES', 'Connecting to Norway…'), 'Conectando a Norway…');
  for (const language of languages.slice(1)) {
    assert.notEqual(translate(language.locale, 'Cancel connection'), 'Cancel connection');
    assert.notEqual(translate(language.locale, 'Taking longer than usual'), 'Taking longer than usual');
  }
});
test('Polish device and location counts use the correct few and many forms', () => {
  assert.equal(translate('pl-PL', '2 devices'), '2 urządzenia');
  assert.equal(translate('pl-PL', '12 devices'), '12 urządzeń');
  assert.equal(translate('pl-PL', '22 locations'), '22 lokalizacje');
  assert.equal(translate('pl-PL', '1 location'), '1 lokalizacja');
});
