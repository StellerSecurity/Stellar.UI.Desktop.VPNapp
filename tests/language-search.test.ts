import test from 'node:test';
import assert from 'node:assert/strict';
import { languages, searchLanguages } from '../src/shared/i18n/languages.ts';
test('language search handles native names, accents, locale codes and translated names', () => {
  assert.deepEqual(searchLanguages('  '), languages);
  for (const [query, name] of [['dansk', 'Dansk'], ['francais', 'Français'], ['TURKCE', 'Türkçe'], ['pt-br', 'Português (Brasil)']]) {
    assert.equal(searchLanguages(query)[0]?.name, name);
  }
  assert.equal(searchLanguages('tysk', name => name === 'Deutsch' ? 'Tysk' : name)[0]?.name, 'Deutsch');
  assert.deepEqual(searchLanguages('no-such-language'), []);
});
