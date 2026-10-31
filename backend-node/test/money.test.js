import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  centsToString, decimalPlaces, hasAtMostPlaces, mulMoney, parseDecimal, percentOfMoney, roundMoney, subtractMoney, sumMoney, toCents,
} from '../src/money.js';
import { allocateInvoiceDiscount, computeInvoiceLine, computeInvoiceTotals } from '../src/auth/invoiceService.js';

// Expected values were produced by test/fixtures/generate-money-fixtures.py with Python's Decimal (half away from
// zero), independent of this code. The JSON is language-neutral so a C# test can run the same cases against InvoiceMath.
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/money-parity.json', import.meta.url), 'utf8'));
const n = (value) => Number(value) + 0; // + 0 turns -0 into 0

describe('exact decimal helpers', () => {
  it('reads numbers as their decimal text', () => {
    assert.deepEqual(parseDecimal(14.5), { n: 145n, s: 1 });
    assert.deepEqual(parseDecimal('12.3400'), { n: 123400n, s: 4 });
    assert.deepEqual(parseDecimal(5e-7), { n: 5n, s: 7 });
    assert.deepEqual(parseDecimal(1e21), { n: 10n ** 21n, s: 0 });
    assert.throws(() => parseDecimal(Number.NaN));
    assert.throws(() => parseDecimal('abc'));
  });

  it('counts decimal places the way C# R(x) != x does', () => {
    assert.equal(decimalPlaces(1.5), 1);
    assert.equal(decimalPlaces('12.3400'), 2);
    assert.equal(decimalPlaces(1.005), 3);
    assert.equal(hasAtMostPlaces(0.1 + 0.2, 2), false); // 0.30000000000000004 is not a 2-place amount
    assert.equal(hasAtMostPlaces(19.99, 2), true);
    assert.equal(hasAtMostPlaces(100, 2), true);
  });

  it('rounds half away from zero, including the cases floats get wrong', () => {
    assert.equal(roundMoney(2.675), 2.68);
    assert.equal(roundMoney(-2.675), -2.68);
    assert.equal(roundMoney(1.005), 1.01);
    assert.equal(roundMoney(-0.005), -0.01);
    assert.equal(roundMoney(0.004999), 0);
    assert.equal(centsToString(toCents(-0.05)), '-0.05');
  });

  it('matches the audit examples: 15% of 14.50 is 2.18, not 2.17', () => {
    assert.equal(percentOfMoney(14.5, 15), 2.18);
    assert.equal(computeInvoiceLine({ description: 'x', quantity: 1, unitPrice: 14.5, taxPercent: 15 }).taxAmount, 2.18);
  });

  it('subtracts without float drift', () => {
    assert.equal(subtractMoney(100.3, 0.1), 100.2); // 100.3 - 0.1 is 100.19999999999999 in floats
    assert.equal(subtractMoney(0.3, 0.1, 0.2), 0);
    assert.equal(sumMoney([0.1, 0.2]), 0.3);
    assert.equal(mulMoney(1.5, 2.55), 3.83);
  });
});

describe('C# InvoiceMath parity fixtures', () => {
  it('invoice line gross, net, tax and total match for every fixture', () => {
    for (const c of fixtures.lines) {
      const out = computeInvoiceLine({ description: 'x', quantity: n(c.q), unitPrice: n(c.p), discount: n(c.d), taxPercent: n(c.t) });
      const label = JSON.stringify(c);
      assert.equal(out.netAmount, n(c.net), `net ${label}`);
      assert.equal(out.taxAmount, n(c.tax), `tax ${label}`);
      assert.equal(out.lineTotal, n(c.total), `total ${label}`);
    }
  });

  it('invoice totals are the exact sum of the line amounts', () => {
    for (let i = 0; i + 3 <= fixtures.lines.length; i += 3) {
      const group = fixtures.lines.slice(i, i + 3);
      const lines = group.map((c) => computeInvoiceLine({ description: 'x', quantity: n(c.q), unitPrice: n(c.p), discount: n(c.d), taxPercent: n(c.t) }));
      const totals = computeInvoiceTotals(lines);
      const cents = (key) => group.reduce((sum, c) => sum + toCents(c[key]), 0n);
      assert.equal(totals.subtotal, n(centsToString(cents('net'))));
      assert.equal(totals.taxTotal, n(centsToString(cents('tax'))));
      assert.equal(totals.total, n(centsToString(cents('total'))));
    }
  });

  it('R(x) matches for midpoints and negatives', () => {
    for (const c of fixtures.rounds) assert.equal(roundMoney(n(c.v)), n(c.r), `R(${c.v})`);
  });

  it('percent-of-amount (deposits) matches', () => {
    for (const c of fixtures.percents) assert.equal(percentOfMoney(n(c.amount), n(c.percent)), n(c.r), JSON.stringify(c));
  });

  it('balances are exact', () => {
    for (const c of fixtures.balances) assert.equal(subtractMoney(n(c.total), n(c.paid), n(c.credited)), n(c.balance), JSON.stringify(c));
  });

  it('order discounts are allocated by largest remainder and add up exactly', () => {
    for (const c of fixtures.allocations) {
      const shares = allocateInvoiceDiscount(c.gross.map(n), n(c.discount));
      assert.deepEqual(shares, c.shares.map(n), JSON.stringify(c));
      assert.equal(sumMoney(shares), n(c.discount));
    }
  });
});

describe('validation', () => {
  it('rejects amounts with more than two decimal places and discounts above the line', () => {
    assert.throws(() => computeInvoiceLine({ description: 'x', quantity: 1, unitPrice: 10.005 }), /at most 2 decimal places/);
    assert.throws(() => computeInvoiceLine({ description: 'x', quantity: 1.001, unitPrice: 10 }), /at most 2 decimal places/);
    assert.throws(() => computeInvoiceLine({ description: 'x', quantity: 1, unitPrice: 10, discount: 10.01 }), /larger than the line/);
    assert.throws(() => computeInvoiceLine({ description: 'x', quantity: 1, unitPrice: 10, taxPercent: 100.5 }), /between 0% and 100%/);
    assert.equal(computeInvoiceLine({ description: 'x', quantity: 1, unitPrice: 10, discount: 10 }).netAmount, 0);
  });
});
