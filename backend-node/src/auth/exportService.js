import { buildCsv, dayText, recordExportAudit } from './csvExport.js';

/*
 * CSV exports for orders, invoices, payments, appointments and inquiries (step 17d).
 *
 * Each export reads through the same list query (passed in by the route), with the same filters, tenant scope and location scope
 * as the screen it belongs to, so a person can never export a row they could not list. The route checks
 * the same permission as the list. Every export writes one audit entry holding the row count and the
 * filter names, never the exported content.
 */

const ORDER_COLUMNS = [
  { header: 'Order number', get: (r) => r.orderNumber },
  { header: 'Status', get: (r) => r.status },
  { header: 'Customer', get: (r) => r.customerName },
  { header: 'Customer ID', get: (r) => r.customerId },
  { header: 'Promised date', get: (r) => dayText(r.promisedDate) },
  { header: 'Priority', get: (r) => r.priority },
  { header: 'Garments', get: (r) => r.garmentCount, kind: 'number' },
  { header: 'Total', get: (r) => r.total, kind: 'number' },
  { header: 'Currency', get: (r) => r.currencyCode },
  { header: 'Order ID', get: (r) => r.id },
];

const INVOICE_COLUMNS = [
  { header: 'Invoice number', get: (r) => r.number },
  { header: 'Kind', get: (r) => r.kind },
  { header: 'Status', get: (r) => r.status },
  { header: 'Payment status', get: (r) => r.paymentStatus },
  { header: 'Customer', get: (r) => r.customerName },
  { header: 'Customer ID', get: (r) => r.customerId },
  { header: 'Order ID', get: (r) => r.orderId },
  { header: 'Issue date', get: (r) => r.issueDate },
  { header: 'Due date', get: (r) => r.dueDate },
  { header: 'Total', get: (r) => r.total, kind: 'number' },
  { header: 'Paid', get: (r) => r.amountPaid, kind: 'number' },
  { header: 'Credited', get: (r) => r.amountCredited, kind: 'number' },
  { header: 'Balance', get: (r) => r.balance, kind: 'number' },
  { header: 'Overdue', get: (r) => r.isOverdue, kind: 'yesno' },
  { header: 'Currency', get: (r) => r.currencyCode },
  { header: 'Invoice ID', get: (r) => r.id },
];

const PAYMENT_COLUMNS = [
  { header: 'Received on', get: (r) => r.receivedOn },
  { header: 'Invoice number', get: (r) => r.invoiceNumber },
  { header: 'Status', get: (r) => r.status },
  { header: 'Amount', get: (r) => r.amount, kind: 'number' },
  { header: 'Currency', get: (r) => r.currencyCode },
  { header: 'Method', get: (r) => r.method },
  { header: 'Reference', get: (r) => r.reference },
  { header: 'Receipt number', get: (r) => r.receiptNumber },
  { header: 'Status reason', get: (r) => r.statusReason },
  { header: 'Notes', get: (r) => r.notes },
  { header: 'Verified at (UTC)', get: (r) => r.verifiedAtUtc ? new Date(r.verifiedAtUtc).toISOString() : '' },
  { header: 'Recorded (UTC)', get: (r) => r.createdAtUtc },
  { header: 'Customer ID', get: (r) => r.customerId },
  { header: 'Invoice ID', get: (r) => r.invoiceId },
  { header: 'Payment ID', get: (r) => r.id },
];

const APPOINTMENT_COLUMNS = [
  { header: 'Start (UTC)', get: (r) => r.startUtc },
  { header: 'End (UTC)', get: (r) => r.endUtc },
  { header: 'Time zone', get: (r) => r.timeZoneId },
  { header: 'Type', get: (r) => r.type },
  { header: 'Status', get: (r) => r.status },
  { header: 'Customer ID', get: (r) => r.customerId },
  { header: 'Order ID', get: (r) => r.orderId },
  { header: 'Location ID', get: (r) => r.locationId },
  { header: 'Assigned membership ID', get: (r) => r.assignedMembershipId },
  { header: 'Notes', get: (r) => r.notes },
  { header: 'Cancellation reason', get: (r) => r.cancellationReason },
  { header: 'Appointment ID', get: (r) => r.id },
];

const INQUIRY_COLUMNS = [
  { header: 'Received (UTC)', get: (r) => r.createdAtUtc ? new Date(r.createdAtUtc).toISOString() : '' },
  { header: 'Kind', get: (r) => r.kind },
  { header: 'Status', get: (r) => r.status },
  { header: 'Name', get: (r) => r.name },
  { header: 'Email', get: (r) => r.email },
  { header: 'Phone', get: (r) => r.phone },
  { header: 'Message', get: (r) => r.message },
  { header: 'Design', get: (r) => r.designName },
  { header: 'Garment type', get: (r) => r.garmentType },
  { header: 'Budget', get: (r) => r.budget },
  { header: 'Preferred date', get: (r) => dayText(r.preferredDate) },
  { header: 'Event date', get: (r) => dayText(r.eventDate) },
  { header: 'Converted order ID', get: (r) => r.convertedOrderId },
  { header: 'Appointment ID', get: (r) => r.appointmentId },
  { header: 'Internal note', get: (r) => r.internalNote },
  { header: 'Handled at (UTC)', get: (r) => r.handledAtUtc ? new Date(r.handledAtUtc).toISOString() : '' },
  { header: 'Request ID', get: (r) => r.id },
];

async function run(pool, user, kind, noun, columns, fetchPage, filters) {
  const result = await buildCsv({ columns, fetchPage, noun });
  await recordExportAudit(pool, user, kind, result.rowCount, filters);
  return result;
}

/*
 * Each function takes fetchPage(page, pageSize), supplied by the route from the same list query the screen uses,
 * and the filter values for the audit entry.
 */
export const exportOrders = (pool, user, fetchPage, filters) => run(pool, user, 'orders', 'orders', ORDER_COLUMNS, fetchPage, filters);
export const exportInvoices = (pool, user, fetchPage, filters) => run(pool, user, 'invoices', 'invoices', INVOICE_COLUMNS, fetchPage, filters);
export const exportPayments = (pool, user, fetchPage, filters) => run(pool, user, 'payments', 'payments', PAYMENT_COLUMNS, fetchPage, filters);
export const exportAppointments = (pool, user, fetchPage, filters) => run(pool, user, 'appointments', 'appointments', APPOINTMENT_COLUMNS, fetchPage, filters);
export const exportInquiries = (pool, user, fetchPage, filters) => run(pool, user, 'inquiries', 'requests', INQUIRY_COLUMNS, fetchPage, filters);
