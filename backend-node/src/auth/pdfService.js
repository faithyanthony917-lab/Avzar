import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { AppError } from '../http/errors.js';
import { getInvoice } from './invoiceService.js';
import { loadTaskDetail } from './orderRoutes.js';

const DEFAULT_ACCENT = '#1f3a5f';
const fmtDate = (value) => value == null ? '-' : String(value instanceof Date ? value.toISOString() : value).slice(0, 10);
const fmtDateTime = (value) => value == null ? '-' : `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function safeFileName(prefix, number, fallback) {
  const cleaned = String(number ?? '').replace(/[^a-z0-9_.-]/gi, '');
  return `${prefix}-${cleaned || fallback}.pdf`;
}

function money(amount, currency) {
  const negative = String(amount).startsWith('-');
  const clean = String(amount).replace(/^[+-]/, '');
  const [whole = '0', fraction = ''] = clean.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${currency} ${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function number2(value) {
  const text = String(value ?? 0);
  const [whole = '0', fraction = ''] = text.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}

function quantity(value) {
  const text = String(value ?? 0);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function lines(value) {
  return String(value ?? '').replaceAll('\r\n', '\n').split('\n').map((line) => line.trimEnd());
}

function bufferPdf(document) {
  const chunks = [];
  const result = new Promise((resolve, reject) => {
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);
  });
  document.end();
  return result;
}

function renderPdf({ title, number, business, meta = [], partyTitle, party, rows, headers, totals = [], sections = [], stamp, footer, rightAligned = [] }) {
  const accent = /^#[0-9a-f]{6}$/i.test(business.BrandColor ?? '') ? business.BrandColor : DEFAULT_ACCENT;
  const doc = new PDFDocument({ size: 'A4', margin: 42, info: { Title: `${title} ${number ?? ''}`.trim(), Author: business.Name } });
  const xRight = 553;
  const businessX = business.Logo ? 128 : 42;
  if (business.Logo) doc.image(business.Logo, 42, 42, { fit: [76, 44] });
  doc.font('Helvetica-Bold').fontSize(17).fillColor(accent).text(business.Name, businessX, 42, { width: 310 - businessX + 42 });
  doc.fontSize(19).fillColor('#1f1f1f').text(title, 330, 42, { width: 223, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor('#5f6368').text([business.Address, [business.ContactPhone, business.ContactEmail].filter(Boolean).join('  |  '),
    business.TaxNumber ? `Tax no. ${business.TaxNumber}` : null].filter(Boolean).join('\n'), 42, 70, { width: 310 });
  if (number) doc.font('Helvetica-Bold').fontSize(10).fillColor('#5f6368').text(number, 330, 70, { width: 223, align: 'right' });
  doc.moveTo(42, 118).lineTo(xRight, 118).strokeColor('#d9d9d9').lineWidth(1).stroke();
  let y = 136;
  if (stamp) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#b3261e').text(stamp, 42, y, { width: 511 });
    y = doc.y + 10;
  }

  if (partyTitle || meta.length) {
    if (partyTitle) {
      doc.font('Helvetica').fontSize(8).fillColor('#5f6368').text(partyTitle.toUpperCase(), 42, y);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#1f1f1f').text(party ?? '-', 42, y + 15, { width: 240 });
    }
    let metaY = y;
    for (const item of meta) {
      doc.font('Helvetica').fontSize(9).fillColor('#5f6368').text(item.label, 315, metaY, { width: 105 });
      doc.fillColor('#1f1f1f').text(String(item.value), 420, metaY, { width: 133, align: 'right' });
      metaY += 16;
    }
    y = Math.max(y + (partyTitle ? 52 : 0), metaY) + 12;
  }

  if (headers?.length) {
    doc.moveTo(42, y).lineTo(xRight, y).strokeColor(accent).stroke();
    y += 7;
    const widths = headers.length === 7 ? [24, 180, 42, 76, 64, 48, 77] : headers.length === 5 ? [24, 260, 48, 90, 89] : [260, 90, 90, 71];
    let x = 42;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#1f1f1f');
    headers.forEach((header, index) => {
      doc.text(header, x, y, { width: widths[index], align: rightAligned.includes(index) ? 'right' : 'left' });
      x += widths[index];
    });
    y += 16;
    for (const row of rows ?? []) {
      const maxHeight = Math.max(...row.map((cell, index) => doc.heightOfString(String(cell ?? ''), { width: widths[index], fontSize: 8 })));
      if (y + maxHeight > 715) { doc.addPage(); y = 48; }
      let cellX = 42;
      doc.font('Helvetica').fontSize(8).fillColor('#1f1f1f');
      row.forEach((cell, index) => {
        doc.text(String(cell ?? ''), cellX, y, { width: widths[index], align: rightAligned.includes(index) ? 'right' : 'left' });
        cellX += widths[index];
      });
      y += maxHeight + 7;
      doc.moveTo(42, y).lineTo(xRight, y).strokeColor('#d9d9d9').lineWidth(0.5).stroke();
      y += 5;
    }
  }

  if (totals.length) {
    y = Math.max(y + 6, doc.y + 8);
    for (const [index, total] of totals.entries()) {
      const bold = index === totals.length - 1;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#1f1f1f')
        .text(total.label, 300, y, { width: 145 }).text(total.value, 445, y, { width: 108, align: 'right' });
      y += 17;
    }
  }

  for (const section of sections) {
    y = Math.max(y + 8, doc.y + 6);
    if (y > 720) { doc.addPage(); y = 48; }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(accent).text(section.heading, 42, y, { width: 511 });
    y = doc.y + 4;
    doc.font('Helvetica').fontSize(9).fillColor('#1f1f1f');
    for (const line of section.lines) {
      doc.text(String(line), 42, y, { width: 511 });
      y = doc.y + 2;
    }
  }
  doc.font('Helvetica').fontSize(8).fillColor('#5f6368').text(footer ?? business.PdfFooterNote ?? '', 42, 770, { width: 511, align: 'center' });
  return bufferPdf(doc);
}

async function locationScope(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`SELECT DISTINCT ml."LocationId" FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0`, [user.userId, user.businessId]);
  return rows.map((row) => row.LocationId);
}

async function businessBranding(pool, user, storage) {
  const { rows } = await pool.query(`SELECT "Name", "BrandColor", "LogoMediaId", "ContactPhone", "ContactEmail", "TaxNumber", "PdfFooterNote",
    (SELECT "Address" FROM "Locations" l WHERE l."BusinessId" = b."Id" AND l."IsActive" AND l."Address" IS NOT NULL ORDER BY l."CreatedAtUtc" LIMIT 1) AS "Address"
    FROM "Businesses" b WHERE b."Id" = $1`, [user.businessId]);
  if (!rows[0]) throw AppError.notFound('business_not_found', 'Business not found.');
  const business = rows[0];
  let logo = null;
  if (business.LogoMediaId) {
    try {
      const media = await pool.query(`SELECT "Id", "BusinessId" FROM "MediaAssets" a WHERE a."BusinessId" = $1 AND a."Id" = $2 AND a."Purpose" <> 'TaskProgressPhoto' AND a."Purpose" <> 'OrderReferenceImage' AND NOT EXISTS (SELECT 1 FROM "TaskProgressPhotos" tp WHERE tp."BusinessId" = a."BusinessId" AND tp."MediaAssetId" = a."Id")`, [user.businessId, business.LogoMediaId]);
      if (media.rows[0]) {
        const key = `${user.businessId.replaceAll('-', '')}/${business.LogoMediaId.replaceAll('-', '')}/md.webp`;
        const stream = await storage.openRead(key);
        if (stream) {
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          logo = await sharp(Buffer.concat(chunks)).png().toBuffer();
        }
      }
    } catch { /* Missing or unreadable branding never blocks a generated document. */ }
  }
  return { ...business, Logo: logo };
}

function finish(doc, prefix, number, fallback) {
  return { content: doc, fileName: safeFileName(prefix, number, fallback) };
}

export async function invoicePdf(pool, user, storage, invoiceId, creditNoteId = null) {
  const invoice = await getInvoice(pool, user, invoiceId, await locationScope(pool, user));
  const business = await businessBranding(pool, user, storage);
  if (creditNoteId) {
    const note = invoice.creditNotes.find((item) => item.id === creditNoteId);
    if (!note) throw AppError.notFound('credit_note_not_found', 'Credit note not found.');
    const content = await renderPdf({ title: 'CREDIT NOTE', number: note.number, business, partyTitle: 'Credited to', party: invoice.customerName,
      meta: [{ label: 'Date', value: fmtDate(note.createdAtUtc) }, { label: 'Against invoice', value: invoice.number ?? '-' }],
      totals: [{ label: 'Credit amount', value: money(note.amount, invoice.currencyCode) }], sections: [{ heading: 'Reason', lines: lines(note.reason) }] });
    return finish(content, 'CreditNote', note.number, 'credit-note');
  }
  const meta = [{ label: 'Issue date', value: fmtDate(invoice.issueDate) }, { label: 'Due date', value: fmtDate(invoice.dueDate) }];
  if (invoice.orderNumber) meta.push({ label: 'Order', value: invoice.orderNumber });
  if (invoice.kind !== 'Standard') meta.push({ label: 'Type', value: invoice.kind });
  if (invoice.paymentStatus) meta.push({ label: 'Payment status', value: invoice.paymentStatus });
  const sections = [];
  const verified = invoice.payments.filter((payment) => payment.status === 'Verified').sort((a, b) => String(a.receivedOn).localeCompare(String(b.receivedOn)))
    .map((payment) => `${fmtDate(payment.receivedOn)}  ${payment.method}  ${money(payment.amount, invoice.currencyCode)}${payment.receiptNumber ? `  (receipt ${payment.receiptNumber})` : ''}`);
  if (verified.length) sections.push({ heading: 'Payments received', lines: verified });
  if (Number(invoice.amountPending) > 0) sections.push({ heading: 'Note', lines: [`${money(invoice.amountPending, invoice.currencyCode)} is awaiting verification and is not counted above.`] });
  if (invoice.notes) sections.push({ heading: 'Notes', lines: lines(invoice.notes) });
  if (invoice.terms) sections.push({ heading: 'Terms', lines: lines(invoice.terms) });
  const stamp = invoice.status === 'Draft' ? 'DRAFT - not a valid invoice' : invoice.status === 'Void' ? `VOID${invoice.voidReason ? ` - ${invoice.voidReason}` : ''}` : null;
  const totals = [{ label: 'Subtotal', value: money(invoice.subtotal, invoice.currencyCode) }, { label: 'Tax', value: money(invoice.taxTotal, invoice.currencyCode) },
    { label: 'Total', value: money(invoice.total, invoice.currencyCode) }];
  if (Number(invoice.amountPaid) > 0) totals.push({ label: 'Paid', value: money(invoice.amountPaid, invoice.currencyCode) });
  if (Number(invoice.amountCredited) > 0) totals.push({ label: 'Credited', value: money(invoice.amountCredited, invoice.currencyCode) });
  if (invoice.status === 'Issued') totals.push({ label: 'Balance due', value: money(invoice.balance, invoice.currencyCode) });
  const content = await renderPdf({ title: 'INVOICE', number: invoice.number ?? 'DRAFT', business, partyTitle: 'Bill to', party: invoice.customerName,
    meta, headers: ['#', 'Description', 'Qty', 'Unit price', 'Discount', 'Tax %', 'Total'],
    rows: invoice.lines.map((line) => [String(line.lineNumber), line.description, quantity(line.quantity), number2(line.unitPrice), number2(line.discount), quantity(line.taxPercent), number2(line.lineTotal)]),
    rightAligned: [0, 2, 3, 4, 5, 6], totals, sections, stamp });
  return finish(content, 'Invoice', invoice.number, 'draft');
}

export async function quotationPdf(pool, user, storage, orderId) {
  const allowed = await locationScope(pool, user);
  const { rows } = await pool.query(`SELECT o.*, c."FullName" AS "CustomerName", o.xmin::text::bigint AS "Version"
    FROM "Orders" o JOIN "Customers" c ON c."BusinessId" = o."BusinessId" AND c."Id" = o."CustomerId"
    WHERE o."BusinessId" = $1 AND o."Id" = $2 AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))`, [user.businessId, orderId, allowed]);
  const order = rows[0];
  if (!order) throw AppError.notFound('order_not_found', 'Order not found.');
  const { rows: garments } = await pool.query(`SELECT "LineNumber", "Name", "Quantity", "UnitPrice", "LineTotal", "Fabric", "Colour", "StyleInstructions", "AlterationNotes"
    FROM "OrderGarments" WHERE "BusinessId" = $1 AND "OrderId" = $2 ORDER BY "LineNumber"`, [user.businessId, orderId]);
  const business = await businessBranding(pool, user, storage);
  const totals = [{ label: 'Subtotal', value: money(order.Subtotal, order.CurrencyCode) }];
  if (Number(order.Discount) > 0) totals.push({ label: 'Discount', value: `-${money(order.Discount, order.CurrencyCode)}` });
  totals.push({ label: 'Quoted total', value: money(order.Total, order.CurrencyCode) });
  const sections = [{ heading: 'Please note', lines: ['This is a quotation, not an invoice. Prices exclude tax; any tax is added when the invoice is issued.'] }];
  if (order.Notes) sections.push({ heading: 'Notes', lines: lines(order.Notes) });
  const stamp = order.Status === 'Draft' ? 'DRAFT - not yet quoted' : order.Status === 'Cancelled' ? 'CANCELLED' : null;
  const content = await renderPdf({ title: 'QUOTATION', number: order.OrderNumber, business, partyTitle: 'Prepared for', party: order.CustomerName,
    meta: [{ label: 'Date', value: fmtDate(order.QuotedAtUtc ?? order.CreatedAtUtc) }, { label: 'Promised date', value: fmtDate(order.PromisedDate) }, { label: 'Delivery', value: order.DeliveryMethod }],
    headers: ['#', 'Item', 'Qty', 'Unit price', 'Total'],
    rows: garments.map((garment) => [String(garment.LineNumber), [garment.Name, garment.Fabric && `Fabric: ${garment.Fabric}`, garment.Colour && `Colour: ${garment.Colour}`,
      garment.StyleInstructions && `Style: ${garment.StyleInstructions}`, garment.AlterationNotes && `Alteration: ${garment.AlterationNotes}`].filter(Boolean).join('\n'),
    String(garment.Quantity), number2(garment.UnitPrice), number2(garment.LineTotal)]), rightAligned: [0, 2, 3, 4], totals, sections, stamp });
  return finish(content, 'Quotation', order.OrderNumber, 'quotation');
}

export async function measurementPdf(pool, user, storage, customerId, setId) {
  const { rows: customers } = await pool.query(`SELECT "FullName" FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2`, [user.businessId, customerId]);
  if (!customers[0]) throw AppError.notFound('customer_not_found', 'Customer not found.');
  const { rows } = await pool.query(`SELECT s."Id", s."Label", s."CurrentRevision", s."UpdatedAtUtc", s."CreatedAtUtc", t."Name" AS "TemplateName", r."ValuesJson"
    FROM "MeasurementSets" s JOIN "MeasurementTemplates" t ON t."BusinessId" = s."BusinessId" AND t."Id" = s."TemplateId"
    JOIN "MeasurementRevisions" r ON r."BusinessId" = s."BusinessId" AND r."SetId" = s."Id" AND r."RevisionNumber" = s."CurrentRevision"
    WHERE s."BusinessId" = $1 AND s."CustomerId" = $2 AND s."Id" = $3`, [user.businessId, customerId, setId]);
  const set = rows[0];
  if (!set) throw AppError.notFound('measurement_set_not_found', 'Measurement profile not found.');
  const values = typeof set.ValuesJson === 'string' ? JSON.parse(set.ValuesJson) : set.ValuesJson;
  const business = await businessBranding(pool, user, storage);
  const content = await renderPdf({ title: 'MEASUREMENT SHEET', business, partyTitle: 'Customer', party: customers[0].FullName,
    meta: [{ label: 'Profile', value: set.Label }, { label: 'Template', value: set.TemplateName }, { label: 'Revision', value: String(set.CurrentRevision) },
      { label: 'Updated', value: fmtDateTime(set.UpdatedAtUtc ?? set.CreatedAtUtc) }],
    headers: ['Measurement', 'Value', 'Unit'], rows: (values ?? []).map((value) => [value.label ?? value.key, quantity(value.value), value.unit ?? '']), rightAligned: [1],
    sections: [{ heading: '', lines: ['Measurements are as recorded at the revision shown. Later changes create a new revision.'] }] });
  return finish(content, 'Measurements', set.Label, 'profile');
}

export async function jobSheetPdf(pool, user, storage, taskId, asWorker = false) {
  let allowed = null;
  if (asWorker) {
    const { rows: memberships } = await pool.query(`SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0`, [user.businessId, user.userId]);
    if (!memberships[0]) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
    const { rows } = await pool.query(`SELECT 1 FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "Id" = $2 AND "AssignedMembershipId" = $3`,
      [user.businessId, taskId, memberships[0].Id]);
    if (!rows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  } else allowed = await locationScope(pool, user);
  const detail = await loadTaskDetail(pool, user.businessId, taskId, allowed, !asWorker);
  const business = await businessBranding(pool, user, storage);
  const task = detail.task;
  const sections = [];
  if (detail.instructions) sections.push({ heading: 'Instructions', lines: lines(detail.instructions) });
  const garment = detail.garment;
  const garmentNotes = [garment.fabric && `Fabric: ${garment.fabric}`, garment.colour && `Colour: ${garment.colour}`,
    garment.styleInstructions && `Style: ${garment.styleInstructions}`, garment.alterationNotes && `Alteration: ${garment.alterationNotes}`].filter(Boolean);
  if (garmentNotes.length) sections.push({ heading: 'Garment', lines: garmentNotes });
  const snapshot = garment.measurementSnapshot?.values;
  const measurements = Array.isArray(snapshot) ? snapshot.map((item) => `${item.label ?? item.key}: ${quantity(item.value)} ${item.unit ?? ''}`.trim())
    : snapshot && typeof snapshot === 'object' ? Object.entries(snapshot).map(([key, value]) => `${key}: ${quantity(value)}`) : [];
  if (measurements.length) sections.push({ heading: 'Measurements (frozen with the order)', lines: measurements });
  if (detail.requiredMaterials.length) sections.push({ heading: 'Materials', lines: detail.requiredMaterials.map((item) => `${quantity(item.quantity)} ${item.unit}  ${item.name}`) });
  if (detail.requiredChecks.length) sections.push({ heading: 'Checks', lines: detail.requiredChecks.map((check) => `${detail.completedChecks.includes(check) ? '[x]' : '[ ]'} ${check}`) });
  if (task.blockedReason) sections.push({ heading: 'Blocked', lines: [task.blockedReason] });
  const content = await renderPdf({ title: 'JOB SHEET', number: task.orderNumber, business: { ...business, Address: null },
    partyTitle: detail.customerName ? 'Customer' : null, party: detail.customerName,
    meta: [{ label: 'Stage', value: task.stageName }, { label: 'Garment', value: `${task.garmentName} x ${task.quantity}` }, { label: 'Priority', value: task.priority },
      { label: 'Deadline', value: fmtDateTime(task.deadlineUtc) }, { label: 'Assigned to', value: task.assigneeName ?? 'Unassigned' },
      ...(task.estimatedMinutes == null ? [] : [{ label: 'Estimate', value: `${task.estimatedMinutes} min` }])],
    sections, footer: 'Printed from the live task. Check the app for the latest status.' });
  return finish(content, 'JobSheet', `${task.orderNumber}-${task.stageName}`, 'task');
}