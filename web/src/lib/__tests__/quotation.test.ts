import { describe, expect, it } from 'vitest';
import { decisionMessage, noteProblem, normalizePortalQuotations, quotationHeadline, sendLabel, type QuotationStatus } from '../quotation';

const base: QuotationStatus = { state: 'NotSent', orderStatus: 'Quoted', sentAtUtc: null, sendCount: 0, decidedAtUtc: null, customerNote: null, canSend: true, readyToConfirm: false };

describe('quotationHeadline and sendLabel', () => {
  it('describes each state', () => {
    expect(quotationHeadline(base)).toMatch(/not sent/i);
    expect(quotationHeadline({ ...base, state: 'Sent', sendCount: 1 })).toMatch(/waiting/i);
    expect(quotationHeadline({ ...base, state: 'Approved', readyToConfirm: true, canSend: false })).toMatch(/ready to convert/i);
    expect(quotationHeadline({ ...base, state: 'Approved', readyToConfirm: false, canSend: false, orderStatus: 'Confirmed' })).toBe('Approved by the customer.');
    expect(quotationHeadline({ ...base, state: 'Declined', canSend: false })).toMatch(/new quotation/i);
    expect(quotationHeadline({ ...base, state: 'NotApplicable' })).toMatch(/no quotation/i);
  });
  it('offers resend only after a first send', () => {
    expect(sendLabel(base)).toBe('Send to customer');
    expect(sendLabel({ ...base, state: 'Sent', sendCount: 2 })).toBe('Resend to customer');
  });
});

describe('noteProblem', () => {
  it('accepts an empty or 500 character message and rejects a longer one', () => {
    expect(noteProblem('')).toBeNull();
    expect(noteProblem('x'.repeat(500))).toBeNull();
    expect(noteProblem('x'.repeat(501))).toMatch(/500/);
    expect(noteProblem(`  ${'x'.repeat(500)}  `)).toBeNull();
  });
});

describe('normalizePortalQuotations', () => {
  const good = { orderId: 'o1', quotationId: 'q1', orderNumber: 'ORD-1', promisedDate: '2026-12-01', currencyCode: 'NGN', subtotal: 60000, discount: 10000, total: 50000,
    sentAtUtc: '2026-10-19T10:00:00Z', decision: null, decidedAtUtc: null, lines: [{ name: 'Agbada', quantity: 1, unitPrice: 60000, lineTotal: 60000 }] };
  it('keeps well-formed quotations', () => {
    const [q] = normalizePortalQuotations({ quotations: [good] });
    expect(q?.orderNumber).toBe('ORD-1');
    expect(q?.lines).toHaveLength(1);
    expect(q?.decision).toBeNull();
  });
  it('drops malformed entries and tolerates a bad payload', () => {
    expect(normalizePortalQuotations(null)).toEqual([]);
    expect(normalizePortalQuotations({ quotations: 'nope' })).toEqual([]);
    expect(normalizePortalQuotations({ quotations: [null, 5, { orderId: 'o1' }, good] })).toHaveLength(1);
  });
  it('ignores an unknown decision value and non-numeric amounts', () => {
    const [q] = normalizePortalQuotations({ quotations: [{ ...good, decision: 'Maybe', total: '5', lines: [null] }] });
    expect(q?.decision).toBeNull();
    expect(q?.total).toBe(0);
    expect(q?.lines[0]).toEqual({ name: '', quantity: 0, unitPrice: 0, lineTotal: 0 });
  });
});

describe('decisionMessage', () => {
  it('confirms what happened', () => {
    expect(decisionMessage('Approved', 'ORD-1')).toMatch(/approved quotation ORD-1/);
    expect(decisionMessage('Declined', 'ORD-1')).toMatch(/declined quotation ORD-1/);
  });
});
