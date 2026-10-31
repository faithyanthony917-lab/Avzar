// Step 16c: the customer message kinds whose wording a business may change, their default wording, the placeholders each one allows,
// and the checks that keep a custom wording safe. Defaults live here (not in the database) so a business with no saved wording
// sends exactly what it sent before 16c. The opt-out line is NOT part of a template: the sender appends it to every message.

export const TEMPLATE_CHANNELS = Object.freeze(['SMS', 'WhatsApp']);
export const TEMPLATE_BODY_MAX = 600;
// Rough length of what the sender adds after every message ("Reply STOP to opt out. Unsubscribe: <link>"); used for the length hint only.
export const OPT_OUT_RESERVED_CHARACTERS = 220;

const PLACEHOLDER = /\{([a-z_]+)\}/g;

export const TEMPLATE_CATALOG = Object.freeze({
  'order.ready': {
    label: 'Order ready',
    description: 'Sent when the last task of an order is finished and the order becomes Ready.',
    default: 'Good news from {business}: order {order} is ready. {next_step}',
    placeholders: Object.freeze({
      business: 'Your business name',
      order: 'The order number',
      next_step: 'Says it is ready for collection, or to contact you to arrange delivery',
    }),
    sample: Object.freeze({ business: 'Taratara Atelier', order: 'ORD-2026-0042', next_step: 'It is ready for collection.' }),
  },
  'order.amended': {
    label: 'Order changed',
    description: 'Sent when an order is amended: promised date and total are read at the moment of sending.',
    default: 'Update from {business}: order {order} was changed. Promised date: {promised_date}. Total: {total}. Reply to the business if you have questions.',
    placeholders: Object.freeze({
      business: 'Your business name',
      order: 'The order number',
      promised_date: 'The promised date now, for example 12 Nov 2026',
      total: 'The order total now, with currency',
    }),
    sample: Object.freeze({ business: 'Taratara Atelier', order: 'ORD-2026-0042', promised_date: '12 Nov 2026', total: 'NGN 45000.00' }),
  },
  'payment.receipt': {
    label: 'Payment receipt',
    description: 'Sent when a payment is recorded or verified and a receipt is issued.',
    default: 'Receipt {receipt} from {business}: we received {amount} for invoice {invoice}. {balance_line} Thank you.',
    placeholders: Object.freeze({
      business: 'Your business name',
      receipt: 'The receipt number',
      invoice: 'The invoice number',
      amount: 'The amount received, with currency',
      balance_line: 'Says the invoice is fully paid, or what balance remains',
    }),
    sample: Object.freeze({ business: 'Taratara Atelier', receipt: 'RCT-2026-00007', invoice: 'INV-2026-00003', amount: 'NGN 20000.00', balance_line: 'Balance remaining: NGN 25000.00.' }),
  },
  'appointment.reminder': {
    label: 'Appointment reminder',
    description: 'Sent a day before and about two hours before a scheduled appointment.',
    default: 'Reminder from {business}: your {type} appointment is {timing} ({when}). Reply to the business if you need to make changes.',
    placeholders: Object.freeze({
      business: 'Your business name',
      type: 'The kind of appointment, for example fitting',
      timing: 'Says tomorrow, or in about two hours',
      when: 'The date and time in your business time zone',
    }),
    sample: Object.freeze({ business: 'Taratara Atelier', type: 'fitting', timing: 'tomorrow', when: '22 Oct 2026, 10:00' }),
  },
});

export const TEMPLATE_KINDS = Object.freeze(Object.keys(TEMPLATE_CATALOG));

export const isTemplateKind = (kind) => Object.prototype.hasOwnProperty.call(TEMPLATE_CATALOG, kind);
export const isTemplateChannel = (channel) => TEMPLATE_CHANNELS.includes(channel);

/**
 * Checks a custom wording. Returns { ok: true, body } (trimmed, line breaks normalised) or { ok: false, errors: [text] }.
 * Plain text only: no links or markup (a business cannot turn a receipt into a phishing message), only the placeholders of that kind.
 */
export function validateTemplateBody(kind, input) {
  if (!isTemplateKind(kind)) return { ok: false, errors: ['Unknown message kind.'] };
  if (typeof input !== 'string') return { ok: false, errors: ['Write the message text.'] };
  const body = input.replace(/\r\n?/g, '\n').trim();
  const errors = [];
  if (!body) errors.push('Write the message text.');
  if (body.length > TEMPLATE_BODY_MAX) errors.push(`Keep the message to ${TEMPLATE_BODY_MAX} characters or fewer.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000B-\u001F\u007F]/.test(body)) errors.push('Remove control characters; only plain text and line breaks are allowed.');
  if (/[<>]/.test(body)) errors.push('Remove the < and > characters; messages are plain text.');
  if (/https?:\/\/|www\./i.test(body)) errors.push('Links are not allowed in a message. The unsubscribe link is added for you.');
  const allowed = TEMPLATE_CATALOG[kind].placeholders;
  const unknown = new Set();
  for (const match of body.matchAll(PLACEHOLDER)) if (!Object.prototype.hasOwnProperty.call(allowed, match[1])) unknown.add(`{${match[1]}}`);
  if (unknown.size) errors.push(`Unknown placeholder ${[...unknown].join(', ')}. Allowed: ${Object.keys(allowed).map((name) => `{${name}}`).join(', ')}.`);
  const stray = body.replace(PLACEHOLDER, '');
  if (/[{}]/.test(stray)) errors.push('Use { and } only around a placeholder name, such as {business}.');
  return errors.length ? { ok: false, errors } : { ok: true, body };
}

/** Fills the placeholders in one pass (a value that itself contains braces is never filled again). A missing value becomes an empty string. */
export function renderTemplate(body, values) {
  return String(body).replace(PLACEHOLDER, (_whole, name) => (values && values[name] !== undefined && values[name] !== null ? String(values[name]) : ''));
}

/** The wording to use: the business's saved wording when it is still valid for this kind, otherwise the default. Never throws. */
export function chooseTemplateBody(kind, customBody) {
  if (typeof customBody === 'string' && validateTemplateBody(kind, customBody).ok) return customBody;
  return TEMPLATE_CATALOG[kind].default;
}

/** Reads the business's saved wording for a kind and channel. Any failure or a missing row gives null (the default is used); a template never stops a message. */
export async function loadCustomTemplate(db, { businessId, kind, channel }) {
  if (!businessId || !isTemplateKind(kind) || !isTemplateChannel(channel)) return null;
  try {
    const { rows } = await db.query('SELECT "Body" FROM "NotificationTemplates" WHERE "BusinessId" = $1 AND "Kind" = $2 AND "Channel" = $3', [businessId, kind, channel]);
    return typeof rows?.[0]?.Body === 'string' ? rows[0].Body : null;
  } catch {
    return null;
  }
}

/**
 * Builds the final text of a message from the values the caller read, using the saved wording if there is one. WhatsApp always uses the
 * default here: since 16d it is sent as a Meta-approved template (whatsappTemplates.js), so a saved WhatsApp wording is ignored.
 */
export async function buildMessageText(db, { businessId, kind, channel, values }) {
  const custom = channel === 'WhatsApp' ? null : await loadCustomTemplate(db, { businessId, kind, channel });
  return renderTemplate(chooseTemplateBody(kind, custom), values);
}
