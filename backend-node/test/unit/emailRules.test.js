import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeHeaderValue, suppressionKey, tryNormalize } from '../../src/email/addressRules.js';
import { nextDelayMs } from '../../src/email/retryPolicy.js';
import { TransportResult } from '../../src/email/transportResult.js';

describe('email address rules', () => {
  it('accepts plain addresses and returns them trimmed', () => {
    assert.equal(tryNormalize('  ada@example.com '), 'ada@example.com');
    assert.equal(tryNormalize('first.last+tag@mail.example.co.uk'), 'first.last+tag@mail.example.co.uk');
  });
  it('rejects display names, whitespace, header injection, bad hosts and oversize input', () => {
    for (const bad of [
      '', '   ', null, undefined, 42, 'Ada <ada@example.com>', 'ada@example.com, bob@example.com', 'ada@example.com;bob@example.com',
      'a da@example.com', 'ada@example.com\r\nBcc: x@y.z', '"ada"@example.com',
      'ada@localhost', 'ada@.example.com', 'ada@example.com.', 'ada@example..com', '.ada@example.com', 'ada.@example.com', 'a..da@example.com',
      '@example.com', 'ada@', 'ada@@example.com', 'a@b@example.com', 'ada@-example.com', `${'a'.repeat(250)}@example.com`,
    ]) assert.equal(tryNormalize(bad), null, String(bad));
  });
  it('builds the suppression key (trimmed, lower-case)', () => {
    assert.equal(suppressionKey('  Ada@Example.COM '), 'ada@example.com');
  });
  it('flags unsafe header values', () => {
    assert.equal(isSafeHeaderValue('Reset your password'), true);
    assert.equal(isSafeHeaderValue('a\nb'), false);
    assert.equal(isSafeHeaderValue('a\rb'), false);
    assert.equal(isSafeHeaderValue(null), false);
  });
});

describe('email retry policy', () => {
  it('backs off 30s, 2m, 8m, 32m, ~2h and caps at 6h', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(nextDelayMs),
      [30_000, 120_000, 480_000, 1_920_000, 7_680_000, 21_600_000, 21_600_000, 21_600_000]);
  });
  it('treats zero or negative attempts as the first attempt', () => {
    assert.equal(nextDelayMs(0), 30_000);
    assert.equal(nextDelayMs(-3), 30_000);
  });
});

describe('transport results', () => {
  it('classifies and truncates', () => {
    assert.deepEqual(TransportResult.ok('abc'), { success: true, transient: false, providerMessageId: 'abc', error: null });
    assert.equal(TransportResult.retry('x').transient, true);
    assert.equal(TransportResult.reject('x').transient, false);
    assert.equal(TransportResult.retry('e'.repeat(1000)).error.length, 400);
  });
});
