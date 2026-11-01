import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCsv, dayText, fileDate, numberCell, recordExportAudit, textCell,
} from '../src/auth/csvExport.js';
import {
  exportAppointments, exportInquiries, exportInvoices, exportOrders, exportPayments,
} from '../src/auth/exportService.js';

const user = { userId: '00000000-0000-4000-8000-000000000001', businessId: '00000000-0000-4000-8000-000000000002' };

function auditPool() {
  const calls = [];
  return { calls, query: async (sql, values) => { calls.push({ sql, values }); return { rows: [] }; } };
}

function pagedSource(rows) {
  const calls = [];
  const fetchPage = async (page, pageSize) => {
    calls.push({ page, pageSize });
    return { items: rows.slice((page - 1) * pageSize, page * pageSize), totalCount: rows.length };
  };
  return { calls, fetchPage };
}

describe('csv cells', () => {
  it('guards text a spreadsheet could read as a formula', () => {
    for (const lead of ['=', '+', '-', '@']) assert.equal(textCell(`${lead}SUM(A1)`), `'${lead}SUM(A1)`);
    assert.equal(textCell('\tcmd'), "'\tcmd");
  });

  it('quotes commas, quotes and line breaks and strips NUL', () => {
    assert.equal(textCell('Ada, Lovelace'), '"Ada, Lovelace"');
    assert.equal(textCell('say "hi"'), '"say ""hi"""');
    assert.equal(textCell('a\r\nb'), '"a\r\nb"');
    assert.equal(textCell('a\0b'), 'ab');
    assert.equal(textCell(null), '');
    assert.equal(textCell(undefined), '');
  });

  it('writes numbers as numbers, so a negative amount keeps its sign', () => {
    assert.equal(numberCell(-1500), '-1500');
    assert.equal(numberCell('125.50'), '125.5');
    assert.equal(numberCell(0), '0');
    assert.equal(numberCell(null), '');
    assert.equal(numberCell('abc'), '');
    assert.equal(numberCell(Infinity), '');
  });

  it('formats a date column the way the rest of the API does', () => {
    assert.equal(dayText(new Date('2026-11-05T00:00:00Z')), '2026-11-05');
    assert.equal(dayText('2026-11-05'), '2026-11-05');
    assert.equal(dayText(null), '');
  });

  it('names the file by date', () => {
    assert.equal(fileDate(new Date('2026-11-01T10:00:00Z')), '20261101');
  });
});

describe('buildCsv', () => {
  const columns = [
    { header: 'Name', get: (r) => r.name },
    { header: 'Amount', get: (r) => r.amount, kind: 'number' },
    { header: 'Late', get: (r) => r.late, kind: 'yesno' },
  ];

  it('writes a BOM, a header and CRLF rows', async () => {
    const { fetchPage } = pagedSource([{ id: 1, name: '=bad', amount: -5, late: true }, { id: 2, name: 'Ok', amount: 7.5, late: false }]);
    const { csv, rowCount } = await buildCsv({ columns, fetchPage });
    assert.equal(rowCount, 2);
    assert.equal(csv, "\uFEFFName,Amount,Late\r\n'=bad,-5,yes\r\nOk,7.5,no\r\n");
  });

  it('reads every page and stops at the last one', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, name: `n${index + 1}`, amount: index, late: false }));
    const { fetchPage, calls } = pagedSource(rows);
    const { rowCount } = await buildCsv({ columns, fetchPage, pageSize: 2 });
    assert.equal(rowCount, 5);
    assert.deepEqual(calls.map((c) => c.page), [1, 2, 3]);
  });

  it('writes only the header for an empty result', async () => {
    const { csv, rowCount } = await buildCsv({ columns, fetchPage: async () => ({ items: [], totalCount: 0 }) });
    assert.equal(rowCount, 0);
    assert.equal(csv, '\uFEFFName,Amount,Late\r\n');
  });

  it('refuses a result over the limit with 413 before reading more pages', async () => {
    const { fetchPage, calls } = pagedSource(Array.from({ length: 10 }, (_, index) => ({ id: index, name: 'x', amount: 1, late: false })));
    await assert.rejects(() => buildCsv({ columns, fetchPage, rowLimit: 9, pageSize: 3 }),
      (error) => error.status === 413 && error.code === 'export_too_large' && /9 rows/.test(error.message));
    assert.equal(calls.length, 1);
  });

  it('does not write a row twice when the data moved between pages', async () => {
    let call = 0;
    const fetchPage = async () => {
      call += 1;
      return call === 1
        ? { items: [{ id: 1, name: 'a', amount: 1, late: false }, { id: 2, name: 'b', amount: 1, late: false }], totalCount: 3 }
        : { items: [{ id: 2, name: 'b', amount: 1, late: false }, { id: 3, name: 'c', amount: 1, late: false }], totalCount: 3 };
    };
    const { rowCount } = await buildCsv({ columns, fetchPage, pageSize: 2 });
    assert.equal(rowCount, 3);
  });
});

describe('export audit', () => {
  it('records the kind, the row count and the filter names, never the search text', async () => {
    const pool = auditPool();
    await recordExportAudit(pool, user, 'invoices', 12, { status: 'Issued', search: 'Ada Obi', from: undefined, overdue: null, customerId: '' });
    assert.equal(pool.calls.length, 1);
    const { sql, values } = pool.calls[0];
    assert.match(sql, /INSERT INTO "AuditLogs"/);
    assert.equal(values[1], 'export.invoices');
    assert.equal(values[2], user.userId);
    assert.equal(values[3], user.businessId);
    assert.deepEqual(JSON.parse(values[4]), { rowCount: 12, filters: { status: 'Issued', search: true } });
  });
});

describe('the five exports', () => {
  const run = async (exporter, items, filters = {}) => {
    const pool = auditPool();
    const { fetchPage } = pagedSource(items);
    const result = await exporter(pool, user, fetchPage, filters);
    return { ...result, pool, lines: result.csv.replace('\uFEFF', '').trimEnd().split('\r\n') };
  };

  it('orders', async () => {
    const { lines, rowCount, pool } = await run(exportOrders, [{
      id: 'o1', orderNumber: 'ORD-1', status: 'Quoted', customerId: 'c1', customerName: '=HYPERLINK("x")', promisedDate: '2026-12-01',
      priority: 'High', garmentCount: 2, total: 45000, currencyCode: 'NGN',
    }], { status: 'Quoted' });
    assert.equal(rowCount, 1);
    assert.equal(lines[0], 'Order number,Status,Customer,Customer ID,Promised date,Priority,Garments,Total,Currency,Order ID');
    assert.equal(lines[1], `ORD-1,Quoted,"'=HYPERLINK(""x"")",c1,2026-12-01,High,2,45000,NGN,o1`);
    assert.equal(pool.calls[0].values[1], 'export.orders');
  });

  it('invoices, with a negative balance kept as a number', async () => {
    const { lines } = await run(exportInvoices, [{
      id: 'i1', number: 'INV-1', kind: 'Invoice', status: 'Issued', paymentStatus: 'Credited', customerName: 'Ada', customerId: 'c1',
      orderId: 'o1', issueDate: '2026-10-01', dueDate: '2026-10-15', total: 100, amountPaid: 0, amountCredited: 100, balance: -0, isOverdue: false, currencyCode: 'NGN',
    }, {
      id: 'i2', number: 'INV-2', kind: 'Invoice', status: 'Issued', paymentStatus: 'Unpaid', customerName: 'Bola', customerId: 'c2',
      orderId: null, issueDate: '2026-10-02', dueDate: null, total: 50, amountPaid: 0, amountCredited: 0, balance: -25.5, isOverdue: true, currencyCode: 'NGN',
    }]);
    assert.equal(lines[0].split(',').length, 16);
    assert.match(lines[2], /,-25\.5,yes,NGN,i2$/);
  });

  it('payments', async () => {
    const { lines } = await run(exportPayments, [{
      id: 'p1', invoiceId: 'i1', invoiceNumber: 'INV-1', customerId: 'c1', amount: -2000, currencyCode: 'NGN', method: 'BankTransfer', reference: '-ref',
      receivedOn: '2026-10-03', status: 'Reversed', notes: 'Line one\nline two', statusReason: null, verifiedAtUtc: '2026-10-04T08:00:00.000Z',
      receiptNumber: 'RCT-1', createdAtUtc: '2026-10-03T09:00:00.000Z',
    }]);
    assert.match(lines.join('\n'), /Reversed,-2000,NGN,BankTransfer,'-ref,RCT-1/);
    assert.match(lines.join('\n'), /"Line one\nline two"/);
    assert.match(lines.join('\n'), /2026-10-04T08:00:00\.000Z/);
  });

  it('appointments', async () => {
    const { lines } = await run(exportAppointments, [{
      id: 'a1', type: 'Fitting', customerId: 'c1', orderId: null, locationId: 'l1', assignedMembershipId: null,
      startUtc: '2026-11-02T09:00:00.000Z', endUtc: '2026-11-02T09:30:00.000Z', timeZoneId: 'Africa/Lagos', status: 'Scheduled', notes: 'Bring shoes', cancellationReason: null,
    }]);
    assert.equal(lines[1], '2026-11-02T09:00:00.000Z,2026-11-02T09:30:00.000Z,Africa/Lagos,Fitting,Scheduled,c1,,l1,,Bring shoes,,a1');
  });

  it('inquiries, with date columns as days', async () => {
    const { lines } = await run(exportInquiries, [{
      id: 'q1', kind: 'Booking', status: 'New', name: 'Ada', email: 'ada@example.com', phone: '+2348000000000', message: 'Hello, please call',
      designId: null, designName: null, garmentType: 'Agbada', budget: '50000', preferredDate: new Date('2026-11-05T00:00:00Z'), eventDate: null,
      convertedOrderId: null, appointmentId: null, internalNote: '@vip', createdAtUtc: new Date('2026-10-31T12:00:00Z'), handledAtUtc: null,
    }]);
    assert.match(lines[1], /^2026-10-31T12:00:00\.000Z,Booking,New,Ada,ada@example\.com,'\+2348000000000,"Hello, please call",,Agbada,50000,2026-11-05,,,,'@vip,,q1$/);
  });

  it('writes no audit entry when the export is refused', async () => {
    const pool = auditPool();
    await assert.rejects(() => exportOrders(pool, user, async () => ({ items: [], totalCount: 50_001 }), {}), (error) => error.status === 413);
    assert.equal(pool.calls.length, 0);
  });
});
