import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReceiptPdf } from '../src/auth/receiptPdfService.js';

const user = {
  userId: '00000000-0000-4000-8000-000000000001',
  businessId: '00000000-0000-4000-8000-000000000002',
  isOwner: true,
};
const receiptId = '00000000-0000-4000-8000-000000000050';

function createPool() {
  const queries = [];
  return {
    queries,
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('FROM "Receipts" r')) {
        return { rows: [{
          Id: receiptId, Number: 'RCT-2026-00001', PaymentId: '00000000-0000-4000-8000-000000000040',
          InvoiceId: '00000000-0000-4000-8000-000000000030', InvoiceNumber: 'INV-2026-00001',
          CustomerId: '00000000-0000-4000-8000-000000000010', CustomerName: 'Ada Lovelace',
          CurrencyCode: 'USD', Amount: '125.5', Method: 'BankTransfer', Reference: 'BANK-42',
          BalanceAfter: '25.00', IssuedAtUtc: '2026-10-17T12:00:00.000Z', VoidedAtUtc: null,
        }] };
      }
      if (sql.includes('FROM "Businesses" b')) {
        return { rows: [{
          Name: 'Avzar Atelier', BrandColor: '#345678', ContactPhone: '+1 555 0100',
          ContactEmail: 'atelier@example.test', TaxNumber: 'TAX-12', PdfFooterNote: 'Made with care',
          Address: '1 Main Street',
        }] };
      }
      throw new Error(`Unexpected PDF query: ${sql}`);
    },
  };
}

describe('receipt PDF generation', () => {
  it('renders a real PDF from tenant-scoped receipt and business branding records', async () => {
    const pool = createPool();
    const pdf = await createReceiptPdf(pool, user, receiptId, null);
    assert.ok(Buffer.isBuffer(pdf.content));
    assert.equal(pdf.content.subarray(0, 5).toString(), '%PDF-');
    assert.equal(pdf.content.subarray(-6).toString(), '%%EOF\n');
    assert.equal(pdf.fileName, 'Receipt-RCT-2026-00001.pdf');
    assert.equal(pool.queries.length, 2);
    assert.deepEqual(pool.queries[0].values, [user.businessId, receiptId]);
    assert.deepEqual(pool.queries[1].values, [user.businessId]);
  });
});
