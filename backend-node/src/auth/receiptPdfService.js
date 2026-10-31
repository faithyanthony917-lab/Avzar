import PDFDocument from 'pdfkit';
import { AppError } from '../http/errors.js';
import { getReceipt } from './paymentService.js';

const DEFAULT_ACCENT = '#1f3a5f';

function safeFileName(number) {
  const clean = String(number ?? '').replace(/[^a-z0-9_.-]/gi, '');
  return `Receipt-${clean || 'receipt'}.pdf`;
}

function money(amount, currencyCode) {
  const formatted = Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currencyCode} ${formatted}`;
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new AppError(500, 'invalid_receipt_date', 'The receipt contains an invalid issue date.');
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function renderReceipt(receipt, business) {
  const accent = /^#[0-9a-f]{6}$/i.test(business.BrandColor ?? '') ? business.BrandColor : DEFAULT_ACCENT;
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `Receipt ${receipt.number}`, Author: business.Name } });
  const chunks = [];
  const content = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const right = 553;
  doc.font('Helvetica-Bold').fontSize(17).fillColor(accent).text(business.Name, 42, 42, { width: 310 });
  doc.fontSize(20).text('RECEIPT', 390, 42, { width: 163, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#5f6368');
  const businessLines = [
    business.Address,
    [business.ContactPhone, business.ContactEmail].filter(Boolean).join('  |  '),
    business.TaxNumber ? `Tax no. ${business.TaxNumber}` : null,
  ].filter(Boolean);
  doc.text(businessLines.join('\n'), 42, 72, { width: 310 });
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1f1f1f').text(receipt.number, 390, 72, { width: 163, align: 'right' });
  doc.moveTo(42, 118).lineTo(right, 118).strokeColor('#d9d9d9').lineWidth(1).stroke();

  if (receipt.isVoid) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#b3261e').text('VOID - this receipt was cancelled', 42, 138);
  }

  const detailsTop = receipt.isVoid ? 168 : 144;
  doc.font('Helvetica').fontSize(9).fillColor('#5f6368').text('RECEIVED FROM', 42, detailsTop);
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#1f1f1f').text(receipt.customerName || '-', 42, detailsTop + 16, { width: 240 });
  const details = [
    ['Date', formatDate(receipt.issuedAtUtc)],
    ['Invoice', receipt.invoiceNumber || '-'],
    ['Method', receipt.method],
    ...(receipt.reference ? [['Reference', receipt.reference]] : []),
  ];
  let y = detailsTop;
  for (const [label, value] of details) {
    doc.font('Helvetica').fontSize(9).fillColor('#5f6368').text(label, 330, y, { width: 95 });
    doc.font('Helvetica').fontSize(9).fillColor('#1f1f1f').text(String(value), 425, y, { width: 128, align: 'right' });
    y += 17;
  }
  const totalTop = Math.max(detailsTop + 76, y + 18);
  doc.moveTo(300, totalTop).lineTo(right, totalTop).strokeColor(accent).lineWidth(1).stroke();
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#1f1f1f')
    .text('Amount received', 300, totalTop + 12, { width: 150 })
    .text(money(receipt.amount, receipt.currencyCode), 450, totalTop + 12, { width: 103, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#5f6368')
    .text('Balance after this payment', 300, totalTop + 35, { width: 150 });
  doc.font('Helvetica').fontSize(9).fillColor('#1f1f1f')
    .text(money(receipt.balanceAfter, receipt.currencyCode), 450, totalTop + 35, { width: 103, align: 'right' });

  doc.moveTo(42, 766).lineTo(right, 766).strokeColor('#d9d9d9').lineWidth(0.5).stroke();
  const footer = [business.PdfFooterNote, 'Thank you for your payment.'].filter(Boolean).join('  |  ');
  doc.font('Helvetica').fontSize(8).fillColor('#5f6368').text(footer, 42, 776, { width: 511, align: 'center' });
  doc.end();
  return content;
}

export async function createReceiptPdf(pool, user, receiptId, allowedLocations) {
  const receipt = await getReceipt(pool, user, receiptId, allowedLocations);
  const { rows } = await pool.query(`
    SELECT b."Name", b."BrandColor", b."ContactPhone", b."ContactEmail", b."TaxNumber", b."PdfFooterNote",
      (SELECT l."Address" FROM "Locations" l
        WHERE l."BusinessId" = b."Id" AND l."IsActive" AND l."Address" IS NOT NULL
        ORDER BY l."CreatedAtUtc" LIMIT 1) AS "Address"
    FROM "Businesses" b
    WHERE b."Id" = $1`,
  [user.businessId]);
  if (!rows.length) throw AppError.notFound('business_not_found', 'Business not found.');
  return { content: await renderReceipt(receipt, rows[0]), fileName: safeFileName(receipt.number) };
}
