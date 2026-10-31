// Step 16b: queueing and wording of the customer messages about an order or a payment. A fake database answers by SQL substring;
// the real SQL (consent filter, suppressions, dedupe, row-level security) runs in test/db/customerEvents.integration.test.js.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOMER_EVENT_KINDS, describeCustomerEvent, formatDateOnly, queueCustomerEvent } from '../../src/messaging/customerEvents.js';

const business = '00000000-0000-4000-8000-0000000000b1';
const customer = '00000000-0000-4000-8000-0000000000c1';
const subject = '00000000-0000-4000-8000-0000000000e1';

const normalized = (sql) => sql.replace(/\s+/g, ' ').trim();

describe('queueCustomerEvent', () => {
  it('queues from the customer\'s consent records only, skipping withdrawn consent and standing stops, and never twice for one key', async () => {
    const calls = [];
    const db = { async query(sql, values) { calls.push({ sql: normalized(sql), values }); return { rows: [{ Id: 'a' }, { Id: 'b' }] }; } };
    const queued = await queueCustomerEvent(db, { businessId: business, customerId: customer, kind: 'order.ready', subjectId: subject, dedupeKey: `order.ready:${subject}:t` });
    assert.equal(queued, 2);
    const [{ sql, values }] = calls;
    assert.deepEqual(values, [business, customer, 'order.ready', subject, `order.ready:${subject}:t`]);
    assert.match(sql, /p\."ConsentStatus" = 'OptedIn' AND p\."ConsentedAtUtc" IS NOT NULL AND p\."OptedOutAtUtc" IS NULL/);
    assert.match(sql, /NOT EXISTS \( SELECT 1 FROM "MessagingSuppressions" s WHERE s\."Channel" = p\."Channel" AND lower\(s\."Address"\) = lower\(p\."Address"\) AND s\."LiftedAtUtc" IS NULL\)/);
    assert.match(sql, /ON CONFLICT \("BusinessId", "DedupeKey", "Channel", "Address"\) DO NOTHING/);
    assert.match(sql, /WHERE p\."BusinessId" = \$1 AND p\."CustomerId" = \$2/);
  });

  it('queues nothing for a customer who has not opted in, which is normal and not an error', async () => {
    const db = { async query() { return { rows: [] }; } };
    assert.equal(await queueCustomerEvent(db, { businessId: business, customerId: customer, kind: 'payment.receipt', subjectId: subject, dedupeKey: 'k' }), 0);
  });

  it('refuses an unknown kind and does nothing without a customer or subject', async () => {
    let calls = 0;
    const db = { async query() { calls += 1; return { rows: [] }; } };
    await assert.rejects(() => queueCustomerEvent(db, { businessId: business, customerId: customer, kind: 'order.shipped', subjectId: subject, dedupeKey: 'k' }), TypeError);
    assert.equal(await queueCustomerEvent(db, { businessId: business, customerId: null, kind: 'order.ready', subjectId: subject, dedupeKey: 'k' }), 0);
    assert.equal(await queueCustomerEvent(db, { businessId: business, customerId: customer, kind: 'order.ready', subjectId: null, dedupeKey: 'k' }), 0);
    assert.equal(calls, 0);
    assert.deepEqual([...CUSTOMER_EVENT_KINDS], ['order.amended', 'order.ready', 'payment.receipt']);
  });

  it('keeps the dedupe key within the column length', async () => {
    const seen = [];
    const db = { async query(_sql, values) { seen.push(values[4]); return { rows: [] }; } };
    await queueCustomerEvent(db, { businessId: business, customerId: customer, kind: 'order.ready', subjectId: subject, dedupeKey: 'x'.repeat(400) });
    assert.equal(seen[0].length, 160);
  });
});

describe('formatDateOnly', () => {
  it('writes a calendar date without shifting it by a time zone', () => {
    assert.equal(formatDateOnly('2026-11-12'), '12 Nov 2026');
    assert.equal(formatDateOnly('2026-01-01'), '1 Jan 2026');
    assert.equal(formatDateOnly(null), '');
    assert.equal(formatDateOnly('soon'), '');
  });
});

describe('describeCustomerEvent', () => {
  const order = (over = {}) => ({ OrderNumber: 'ORD-2026-0042', Status: 'Ready', PromisedDate: '2026-11-12', Total: '45000.00', DeliveryMethod: 'Collection', BusinessName: 'Taratara Atelier', CurrencyCode: 'NGN', ...over });
  const receipt = (over = {}) => ({ Number: 'RCT-2026-00007', Amount: '20000.00', BalanceAfter: '25000.00', VoidedAtUtc: null, PaymentStatus: 'Verified', InvoiceNumber: 'INV-2026-00003', CurrencyCode: 'NGN', BusinessName: 'Taratara Atelier', ...over });
  const dbWith = (rows) => { const calls = []; return { calls, async query(sql, values) { calls.push({ sql: normalized(sql), values }); return { rows }; } }; };
  const job = (kind) => ({ Kind: kind, BusinessId: business, CustomerId: customer, SubjectId: subject });

  it('reads the order for this business, customer and subject', async () => {
    const db = dbWith([order()]);
    await describeCustomerEvent(db, job('order.ready'));
    assert.deepEqual(db.calls[0].values, [business, subject, customer]);
    assert.match(db.calls[0].sql, /WHERE o\."BusinessId" = \$1 AND o\."Id" = \$2 AND o\."CustomerId" = \$3/);
  });

  it('order ready: says it is ready for collection or to arrange delivery, and is not sent once the order is no longer Ready', async () => {
    const collection = await describeCustomerEvent(dbWith([order()]), job('order.ready'));
    assert.deepEqual({ eligible: collection.eligible, text: collection.text }, { eligible: true, text: 'Good news from Taratara Atelier: order ORD-2026-0042 is ready. It is ready for collection.' });
    const delivery = await describeCustomerEvent(dbWith([order({ DeliveryMethod: 'Delivery' })]), job('order.ready'));
    assert.match(delivery.text, /Contact us to arrange delivery\.$/);
    assert.deepEqual(await describeCustomerEvent(dbWith([order({ Status: 'InProduction' })]), job('order.ready')), { eligible: false });
    assert.deepEqual(await describeCustomerEvent(dbWith([]), job('order.ready')), { eligible: false });
  });

  it('order amended: gives the promised date and total as they are now, and is not sent for a cancelled or unconfirmed order', async () => {
    const sent = await describeCustomerEvent(dbWith([order({ Status: 'InProduction' })]), job('order.amended'));
    assert.deepEqual({ eligible: sent.eligible, text: sent.text }, { eligible: true, text: 'Update from Taratara Atelier: order ORD-2026-0042 was changed. Promised date: 12 Nov 2026. Total: NGN 45000.00. Reply to the business if you have questions.' });
    for (const status of ['Cancelled', 'Draft', 'Quoted']) {
      assert.deepEqual(await describeCustomerEvent(dbWith([order({ Status: status })]), job('order.amended')), { eligible: false }, status);
    }
    assert.equal((await describeCustomerEvent(dbWith([order({ Status: 'Delivered' })]), job('order.amended'))).eligible, true);
  });

  it('payment receipt: gives the amount, invoice and balance, says when the invoice is fully paid, and is not sent for a reversed payment or voided receipt', async () => {
    const db = dbWith([receipt()]);
    const partial = await describeCustomerEvent(db, job('payment.receipt'));
    assert.deepEqual({ eligible: partial.eligible, text: partial.text }, { eligible: true, text: 'Receipt RCT-2026-00007 from Taratara Atelier: we received NGN 20000.00 for invoice INV-2026-00003. Balance remaining: NGN 25000.00. Thank you.' });
    assert.deepEqual(db.calls[0].values, [business, subject, customer]);
    assert.match(db.calls[0].sql, /WHERE r\."BusinessId" = \$1 AND r\."PaymentId" = \$2 AND i\."CustomerId" = \$3/);
    const paid = await describeCustomerEvent(dbWith([receipt({ BalanceAfter: '0.00' })]), job('payment.receipt'));
    assert.match(paid.text, /Your invoice is now fully paid\. Thank you\.$/);
    assert.deepEqual(await describeCustomerEvent(dbWith([receipt({ PaymentStatus: 'Reversed' })]), job('payment.receipt')), { eligible: false });
    assert.deepEqual(await describeCustomerEvent(dbWith([receipt({ VoidedAtUtc: new Date() })]), job('payment.receipt')), { eligible: false });
  });

  it('step 16c: uses the business\'s saved SMS wording, filled from the facts as they are now, and falls back to the default when none is saved; step 16d: WhatsApp ignores saved wording', async () => {
    const calls = [];
    const db = { async query(sql, values) {
      calls.push({ sql: normalized(sql), values });
      if (normalized(sql).startsWith('SELECT "Body" FROM "NotificationTemplates"')) return { rows: [{ Body: 'Hello! {order} is done at {business}. {next_step}' }] };
      return { rows: [order()] };
    } };
    const sms = await describeCustomerEvent(db, { ...job('order.ready'), Channel: 'SMS' });
    assert.equal(sms.text, 'Hello! ORD-2026-0042 is done at Taratara Atelier. It is ready for collection.');
    const template = calls.find((call) => call.sql.includes('"NotificationTemplates"'));
    assert.deepEqual(template.values, [business, 'order.ready', 'SMS']);
    const before = calls.length;
    const whatsapp = await describeCustomerEvent(db, { ...job('order.ready'), Channel: 'WhatsApp' });
    assert.equal(whatsapp.text, 'Good news from Taratara Atelier: order ORD-2026-0042 is ready. It is ready for collection.');
    assert.deepEqual([whatsapp.kind, whatsapp.values], ['order.ready', { business: 'Taratara Atelier', order: 'ORD-2026-0042', next_step: 'It is ready for collection.' }]);
    assert.ok(!calls.slice(before).some((call) => call.sql.includes('"NotificationTemplates"')), 'no saved wording is read for WhatsApp');
  });

  it('step 16c: a saved wording does not make an ineligible message eligible, and an invalid saved wording sends the default', async () => {
    const withTemplate = (rows, body) => ({ async query(sql) { return normalized(sql).startsWith('SELECT "Body"') ? { rows: [{ Body: body }] } : { rows }; } });
    assert.deepEqual(await describeCustomerEvent(withTemplate([order({ Status: 'InProduction' })], 'Ready {order}'), { ...job('order.ready'), Channel: 'SMS' }), { eligible: false });
    const invalid = await describeCustomerEvent(withTemplate([order()], 'See https://evil.example {order}'), { ...job('order.ready'), Channel: 'SMS' });
    assert.match(invalid.text, /^Good news from Taratara Atelier/);
  });

  it('never puts staff notes, addresses or other customers\' data in the text', async () => {
    const texts = [
      (await describeCustomerEvent(dbWith([order({ Notes: 'Secret note', DeliveryAddress: '1 Hidden Street' })]), job('order.ready'))).text,
      (await describeCustomerEvent(dbWith([order({ Status: 'Confirmed', Notes: 'Secret note', DeliveryAddress: '1 Hidden Street' })]), job('order.amended'))).text,
    ].join(' ');
    assert.ok(!texts.includes('Secret note') && !texts.includes('Hidden Street'));
  });
});
