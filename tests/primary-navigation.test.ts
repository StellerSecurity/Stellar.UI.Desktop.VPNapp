import test from 'node:test';
import assert from 'node:assert/strict';
import { primaryViewForKey } from '../src/app/PrimaryNavigation.ts';

test('primary navigation arrows follow the three main tabs and wrap; Devices belongs to Settings', () => {
  assert.equal(primaryViewForKey('connection', 'ArrowRight'), 'settings');
  assert.equal(primaryViewForKey('settings', 'ArrowRight'), 'account');
  assert.equal(primaryViewForKey('account', 'ArrowRight'), 'connection');
  assert.equal(primaryViewForKey('connection', 'ArrowLeft'), 'account');
  assert.equal(primaryViewForKey('account', 'ArrowLeft'), 'settings');
});
test('Home and End select boundary tabs; unrelated keys are left alone', () => {
  assert.equal(primaryViewForKey('account', 'Home'), 'connection');
  assert.equal(primaryViewForKey('connection', 'End'), 'account');
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape', 'a']) assert.equal(primaryViewForKey('account', key), null);
});
