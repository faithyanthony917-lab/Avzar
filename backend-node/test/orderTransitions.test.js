import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EDITABLE,
  INVOICEABLE,
  ORDER_STATUSES,
  PRODUCTION_ACTIVE,
  PRODUCTION_OPEN,
  allowedNextStatuses,
  canTransition,
  isEditable,
  isInvoiceable,
  isOrderStatus,
  isProductionActive,
  isProductionOpen,
  sqlStatusList,
} from '../src/auth/orderTransitions.js';

const EXPECTED = {
  Draft: ['Quoted', 'Cancelled'],
  Quoted: ['Draft', 'Confirmed', 'Cancelled'],
  Confirmed: ['InProduction', 'Ready', 'Cancelled'],
  InProduction: ['Ready', 'Cancelled'],
  Ready: ['InProduction', 'Delivered', 'Cancelled'],
  Delivered: [],
  Cancelled: [],
};

describe('order transition table', () => {
  it('lists the seven statuses the code already used', () => {
    assert.deepEqual([...ORDER_STATUSES],
      ['Draft', 'Quoted', 'Confirmed', 'InProduction', 'Ready', 'Delivered', 'Cancelled']);
  });

  it('allows exactly the moves below and refuses every other pair', () => {
    for (const from of ORDER_STATUSES) {
      assert.deepEqual(allowedNextStatuses(from).sort(), [...EXPECTED[from]].sort(), `from ${from}`);
      for (const to of ORDER_STATUSES) {
        assert.equal(canTransition(from, to), EXPECTED[from].includes(to), `${from} to ${to}`);
      }
    }
  });

  it('treats Delivered and Cancelled as final', () => {
    assert.deepEqual(allowedNextStatuses('Delivered'), []);
    assert.deepEqual(allowedNextStatuses('Cancelled'), []);
  });

  it('refuses unknown statuses instead of throwing', () => {
    assert.equal(canTransition('Nope', 'Quoted'), false);
    assert.equal(canTransition('Draft', 'Nope'), false);
    assert.deepEqual(allowedNextStatuses('Nope'), []);
    assert.equal(isOrderStatus('Nope'), false);
    assert.equal(isOrderStatus(undefined), false);
  });

  it('every non-Draft status can be reached from Draft', () => {
    const seen = new Set(['Draft']);
    const queue = ['Draft'];
    while (queue.length) {
      for (const next of allowedNextStatuses(queue.shift())) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    assert.deepEqual([...seen].sort(), [...ORDER_STATUSES].sort());
  });

  it('returns a copy so callers cannot change the table', () => {
    const next = allowedNextStatuses('Draft');
    next.push('Delivered');
    assert.equal(canTransition('Draft', 'Delivered'), false);
  });

  it('only allows delivery from Ready and quoting from Draft', () => {
    assert.deepEqual(ORDER_STATUSES.filter((s) => canTransition(s, 'Delivered')), ['Ready']);
    assert.deepEqual(ORDER_STATUSES.filter((s) => canTransition(s, 'Quoted')), ['Draft']);
    assert.deepEqual(ORDER_STATUSES.filter((s) => canTransition(s, 'Confirmed')), ['Quoted']);
  });
});

describe('order status groups', () => {
  it('only hold known statuses and match the checks the routes used before', () => {
    for (const group of [EDITABLE, PRODUCTION_ACTIVE, PRODUCTION_OPEN, INVOICEABLE]) {
      for (const status of group) assert.ok(isOrderStatus(status), status);
    }
    assert.deepEqual([...EDITABLE], ['Draft', 'Quoted']);
    assert.deepEqual([...PRODUCTION_ACTIVE], ['Confirmed', 'InProduction']);
    assert.deepEqual([...PRODUCTION_OPEN], ['Confirmed', 'InProduction', 'Ready']);
    assert.deepEqual([...INVOICEABLE], ['Confirmed', 'InProduction', 'Ready', 'Delivered']);
  });

  it('answer per status', () => {
    for (const status of ORDER_STATUSES) {
      assert.equal(isEditable(status), ['Draft', 'Quoted'].includes(status));
      assert.equal(isProductionActive(status), ['Confirmed', 'InProduction'].includes(status));
      assert.equal(isProductionOpen(status), ['Confirmed', 'InProduction', 'Ready'].includes(status));
      assert.equal(isInvoiceable(status), ['Confirmed', 'InProduction', 'Ready', 'Delivered'].includes(status));
    }
  });

  it('builds a quoted SQL list and refuses an unknown status', () => {
    assert.equal(sqlStatusList(PRODUCTION_ACTIVE), "'Confirmed', 'InProduction'");
    assert.throws(() => sqlStatusList(["Draft'; DROP TABLE x; --"]), /Unknown order status/);
  });
});

describe('no route keeps its own list of order statuses', () => {
  const read = (file) => readFileSync(new URL(`../src/auth/${file}`, import.meta.url), 'utf8');

  it('orderRoutes.js and invoiceService.js have no hard-coded status list', () => {
    for (const file of ['orderRoutes.js', 'invoiceService.js']) {
      const source = read(file);
      assert.doesNotMatch(source, /\[[^\]\n]*'(Confirmed|InProduction|Delivered)'[^\]\n]*\]/, `${file}: array of order statuses`);
      assert.doesNotMatch(source, /\['Draft', 'Quoted'/, `${file}: editable list`);
      assert.doesNotMatch(source, /IN \([^)\n]*'(Confirmed|InProduction)'[^)\n]*\)/, `${file}: SQL list of order statuses`);
    }
  });

  it('every status written to Orders is a known status that some move leads to', () => {
    const source = read('orderRoutes.js');
    const written = new Set();
    for (const match of source.matchAll(/UPDATE "Orders" SET[^;`]*?"Status" = '(\w+)'/g)) written.add(match[1]);
    assert.ok(written.size >= 5, 'expected the quote, confirm, cancel, deliver and sync updates');
    for (const status of written) {
      assert.ok(isOrderStatus(status), `${status} is not a known status`);
      assert.ok(ORDER_STATUSES.some((from) => canTransition(from, status)), `no move leads to ${status}`);
    }
  });
});
