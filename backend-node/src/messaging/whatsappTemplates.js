// Step 16d: WhatsApp may start a conversation with a customer only through a message template that Meta approved in advance.
// One platform-wide set of four templates serves every business (one sender number, as for SMS). The business's saved wording
// (16c) applies to SMS only. Each template body below is what must be created in Meta (see docs/WHATSAPP_SETUP.md); the numbered
// variables {{1}}, {{2}} ... are filled from the same facts the SMS text uses, and the LAST variable is always the opt-out link.
// A body never starts or ends with a variable (Meta refuses that).

export const WHATSAPP_OPT_OUT_PHRASE = 'To stop these messages, reply STOP or use this link: ';
const OPT_OUT_TAIL = (n) => `${WHATSAPP_OPT_OUT_PHRASE}{{${n}}}. Thank you.`;

export const WHATSAPP_TEMPLATES = Object.freeze({
  'appointment.reminder': {
    name: 'avzar_appointment_reminder',
    params: Object.freeze(['business', 'type', 'timing', 'when']),
    body: `Reminder from {{1}}: your {{2}} appointment is {{3}} ({{4}}). Reply to the business if you need to make changes. ${OPT_OUT_TAIL(5)}`,
  },
  'order.amended': {
    name: 'avzar_order_amended',
    params: Object.freeze(['business', 'order', 'promised_date', 'total']),
    body: `Update from {{1}}: order {{2}} was changed. Promised date: {{3}}. Total: {{4}}. Reply to the business if you have questions. ${OPT_OUT_TAIL(5)}`,
  },
  'order.ready': {
    name: 'avzar_order_ready',
    params: Object.freeze(['business', 'order', 'next_step']),
    body: `Good news from {{1}}: order {{2}} is ready. {{3}} ${OPT_OUT_TAIL(4)}`,
  },
  'payment.receipt': {
    name: 'avzar_payment_receipt',
    params: Object.freeze(['receipt', 'business', 'amount', 'invoice', 'balance_line']),
    body: `Receipt {{1}} from {{2}}: we received {{3}} for invoice {{4}}. {{5}} ${OPT_OUT_TAIL(6)}`,
  },
});

export const WHATSAPP_TEMPLATE_KINDS = Object.freeze(Object.keys(WHATSAPP_TEMPLATES));
const LANGUAGE = /^[a-z]{2,3}(_[A-Z]{2})?$/;
const FALLBACK_OPT_OUT = 'reply STOP';

/** A template variable: one line, no tabs, no long runs of spaces, never empty (Meta refuses empty variables). */
export function cleanTemplateParam(value, max = 200) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (!text) return '-';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The link variable is never cut (a cut link would not work); without a usable link the customer is told to reply STOP. */
export function optOutParam(link) {
  const text = typeof link === 'string' ? link.trim() : '';
  return text && text.length <= 600 && !/\s/.test(text) ? text : FALLBACK_OPT_OUT;
}

/** { name, language, parameters } for a message kind, or null when the kind has no template. */
export function buildWhatsAppTemplate({ kind, values, optOutLink, env = process.env }) {
  const entry = WHATSAPP_TEMPLATES[kind];
  if (!entry) return null;
  const language = LANGUAGE.test(env?.META_WHATSAPP_TEMPLATE_LANGUAGE ?? '') ? env.META_WHATSAPP_TEMPLATE_LANGUAGE : 'en';
  return {
    name: entry.name,
    language,
    parameters: [...entry.params.map((name) => cleanTemplateParam(values?.[name])), optOutParam(optOutLink)],
  };
}
