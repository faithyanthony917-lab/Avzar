// Step 16c: the default wording, the placeholder rules and the fallback behaviour of customer message templates. No database.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATE_CATALOG, TEMPLATE_KINDS, buildMessageText, chooseTemplateBody, loadCustomTemplate, renderTemplate, validateTemplateBody,
} from '../../src/messaging/templateCatalog.js';

const BUSINESS = '00000000-0000-4000-8000-0000000000b1';

describe('template catalog', () => {
  it('has the four customer kinds, and each default uses only its own placeholders', () => {
    assert.deepEqual([...TEMPLATE_KINDS], ['order.ready', 'order.amended', 'payment.receipt', 'appointment.reminder']);
    for (const kind of TEMPLATE_KINDS) {
      const entry = TEMPLATE_CATALOG[kind];
      assert.equal(validateTemplateBody(kind, entry.default).ok, true, `${kind} default is valid`);
      assert.deepEqual(Object.keys(entry.sample).sort(), Object.keys(entry.placeholders).sort(), `${kind} sample covers every placeholder`);
      const text = renderTemplate(entry.default, entry.sample);
      assert.ok(!/[{}]/.test(text), `${kind} default fills completely`);
    }
  });

  it('keeps the exact wording sent before step 16c', () => {
    const c = TEMPLATE_CATALOG;
    assert.equal(renderTemplate(c['order.ready'].default, { business: 'B', order: 'O-1', next_step: 'It is ready for collection.' }), 'Good news from B: order O-1 is ready. It is ready for collection.');
    assert.equal(renderTemplate(c['order.amended'].default, { business: 'B', order: 'O-1', promised_date: '12 Nov 2026', total: 'NGN 5.00' }), 'Update from B: order O-1 was changed. Promised date: 12 Nov 2026. Total: NGN 5.00. Reply to the business if you have questions.');
    assert.equal(renderTemplate(c['payment.receipt'].default, { business: 'B', receipt: 'R-1', invoice: 'I-1', amount: 'NGN 2.00', balance_line: 'Your invoice is now fully paid.' }), 'Receipt R-1 from B: we received NGN 2.00 for invoice I-1. Your invoice is now fully paid. Thank you.');
    assert.equal(renderTemplate(c['appointment.reminder'].default, { business: 'B', type: 'fitting', timing: 'tomorrow', when: 'X' }), 'Reminder from B: your fitting appointment is tomorrow (X). Reply to the business if you need to make changes.');
  });
});

describe('validateTemplateBody', () => {
  it('accepts plain text with allowed placeholders and trims it', () => {
    assert.deepEqual(validateTemplateBody('order.ready', '  Hi! {order} is ready.\r\nCome by.  '), { ok: true, body: 'Hi! {order} is ready.\nCome by.' });
  });

  it('rejects placeholders of another kind, unknown ones and stray braces', () => {
    assert.match(validateTemplateBody('order.ready', 'Total {total}').errors.join(' '), /Unknown placeholder \{total\}/);
    assert.match(validateTemplateBody('order.ready', '{Business}').errors.join(' '), /only around a placeholder/);
    assert.match(validateTemplateBody('order.ready', 'Hi } there').errors.join(' '), /only around a placeholder/);
    assert.equal(validateTemplateBody('order.shipped', 'Hi').ok, false);
  });

  it('rejects links, markup, control characters, empty and over-long text', () => {
    for (const body of ['http://a.b', 'HTTPS://a.b', 'go to www.a.b', '<a>', 'a > b', 'bell\u0007', '', '   ', 'x'.repeat(601)]) {
      assert.equal(validateTemplateBody('order.ready', body).ok, false, JSON.stringify(body));
    }
    assert.equal(validateTemplateBody('order.ready', 'x'.repeat(600)).ok, true);
    assert.equal(validateTemplateBody('order.ready', 42).ok, false);
  });
});

describe('renderTemplate', () => {
  it('fills in one pass: a value that contains braces is not filled again, and a missing value is empty', () => {
    assert.equal(renderTemplate('A {business} B {order}', { business: '{order}', order: null }), 'A {order} B ');
    assert.equal(renderTemplate('Hi {business}', undefined), 'Hi ');
  });
});

describe('chooseTemplateBody and loadCustomTemplate', () => {
  it('uses the saved wording only when it is still valid for the kind, otherwise the default', () => {
    assert.equal(chooseTemplateBody('order.ready', 'Mine {order}'), 'Mine {order}');
    assert.equal(chooseTemplateBody('order.ready', 'Mine {gone}'), TEMPLATE_CATALOG['order.ready'].default);
    assert.equal(chooseTemplateBody('order.ready', null), TEMPLATE_CATALOG['order.ready'].default);
  });

  it('reads one row by business, kind and channel, and gives null for no row, a bad channel or a database failure', async () => {
    const calls = [];
    const db = { async query(sql, values) { calls.push({ sql: sql.replace(/\s+/g, ' '), values }); return { rows: [{ Body: 'Mine {order}' }] }; } };
    assert.equal(await loadCustomTemplate(db, { businessId: BUSINESS, kind: 'order.ready', channel: 'SMS' }), 'Mine {order}');
    assert.deepEqual(calls[0].values, [BUSINESS, 'order.ready', 'SMS']);
    assert.match(calls[0].sql, /WHERE "BusinessId" = \$1 AND "Kind" = \$2 AND "Channel" = \$3/);
    assert.equal(await loadCustomTemplate({ async query() { return { rows: [] }; } }, { businessId: BUSINESS, kind: 'order.ready', channel: 'SMS' }), null);
    assert.equal(await loadCustomTemplate(db, { businessId: BUSINESS, kind: 'order.ready', channel: 'Email' }), null);
    assert.equal(calls.length, 1, 'a bad channel does not reach the database');
    assert.equal(await loadCustomTemplate({ async query() { throw new Error('relation does not exist'); } }, { businessId: BUSINESS, kind: 'order.ready', channel: 'SMS' }), null);
  });

  it('buildMessageText never fails because of a template: a database error sends the default', async () => {
    const broken = { async query() { throw new Error('boom'); } };
    const text = await buildMessageText(broken, { businessId: BUSINESS, kind: 'order.ready', channel: 'SMS', values: { business: 'B', order: 'O-1', next_step: 'Go.' } });
    assert.equal(text, 'Good news from B: order O-1 is ready. Go.');
  });
});
