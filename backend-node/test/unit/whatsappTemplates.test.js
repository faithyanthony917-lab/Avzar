// Step 16d: the fixed WhatsApp message templates and how their variables are filled.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WHATSAPP_TEMPLATES, WHATSAPP_TEMPLATE_KINDS, buildWhatsAppTemplate, cleanTemplateParam, optOutParam } from '../../src/messaging/whatsappTemplates.js';
import { CUSTOMER_EVENT_KINDS } from '../../src/messaging/customerEvents.js';
import { TEMPLATE_CATALOG, TEMPLATE_KINDS } from '../../src/messaging/templateCatalog.js';

const LINK = 'https://app.example.com/unsubscribe#abc.def';

describe('WhatsApp templates', () => {
  it('has one template for every customer message kind, and only those', () => {
    assert.deepEqual([...WHATSAPP_TEMPLATE_KINDS].sort(), [...TEMPLATE_KINDS].sort());
    for (const kind of CUSTOMER_EVENT_KINDS) assert.ok(WHATSAPP_TEMPLATES[kind], kind);
  });

  it('numbers its variables 1..n with the opt-out link last, never starts or ends a body with a variable, and uses valid Meta names', () => {
    for (const [kind, entry] of Object.entries(WHATSAPP_TEMPLATES)) {
      const numbers = [...entry.body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
      assert.deepEqual(numbers, Array.from({ length: entry.params.length + 1 }, (_, i) => i + 1), kind);
      assert.ok(!/^\{\{/.test(entry.body) && !/\}\}$/.test(entry.body), `${kind} must not start or end with a variable`);
      assert.match(entry.name, /^[a-z0-9_]{1,512}$/);
      assert.match(entry.body, /reply STOP/);
      assert.ok(entry.body.length <= 1024, kind);
      // Every named fact is something the SMS wording also uses for that kind.
      for (const name of entry.params) assert.ok(Object.hasOwn(TEMPLATE_CATALOG[kind].placeholders, name), `${kind}: ${name}`);
    }
  });

  it('fills the variables in order from the facts, then the link, in the configured language', () => {
    const built = buildWhatsAppTemplate({ kind: 'order.ready', values: { business: 'Taratara Atelier', order: 'ORD-1', next_step: 'It is ready for collection.' }, optOutLink: LINK, env: { META_WHATSAPP_TEMPLATE_LANGUAGE: 'en_GB' } });
    assert.deepEqual(built, { name: 'avzar_order_ready', language: 'en_GB', parameters: ['Taratara Atelier', 'ORD-1', 'It is ready for collection.', LINK] });
    const receipt = buildWhatsAppTemplate({ kind: 'payment.receipt', values: { receipt: 'RCT-1', business: 'B', amount: 'NGN 1.00', invoice: 'INV-1', balance_line: 'Your invoice is now fully paid.' }, optOutLink: LINK, env: {} });
    assert.deepEqual(receipt.parameters, ['RCT-1', 'B', 'NGN 1.00', 'INV-1', 'Your invoice is now fully paid.', LINK]);
    assert.equal(receipt.language, 'en');
  });

  it('returns null for a kind with no template, and falls back to English for a malformed language', () => {
    assert.equal(buildWhatsAppTemplate({ kind: 'order.shipped', values: {}, optOutLink: LINK }), null);
    assert.equal(buildWhatsAppTemplate({ kind: 'order.ready', values: {}, optOutLink: LINK, env: { META_WHATSAPP_TEMPLATE_LANGUAGE: 'en; drop table' } }).language, 'en');
  });

  it('cleans variables: one line, no runs of spaces, never empty, cut when long', () => {
    assert.equal(cleanTemplateParam('a\nb\t c    d'), 'a b c d');
    assert.equal(cleanTemplateParam('   '), '-');
    assert.equal(cleanTemplateParam(undefined), '-');
    assert.equal(cleanTemplateParam('x'.repeat(300)).length, 200);
    assert.match(cleanTemplateParam('x'.repeat(300)), /…$/);
  });

  it('never cuts the link, and asks the customer to reply STOP when there is no usable link', () => {
    assert.equal(optOutParam(LINK), LINK);
    assert.equal(optOutParam(null), 'reply STOP');
    assert.equal(optOutParam('has space'), 'reply STOP');
    assert.equal(optOutParam(`https://x.example/${'a'.repeat(700)}`), 'reply STOP');
    assert.equal(buildWhatsAppTemplate({ kind: 'order.ready', values: { business: 'B', order: 'O', next_step: 'N' }, optOutLink: null }).parameters.at(-1), 'reply STOP');
  });

  it('is documented exactly: docs/WHATSAPP_SETUP.md carries every template name and body as the code has them', () => {
    const doc = readFileSync(new URL('../../../docs/WHATSAPP_SETUP.md', import.meta.url), 'utf8');
    for (const entry of Object.values(WHATSAPP_TEMPLATES)) {
      assert.ok(doc.includes(`### \`${entry.name}\``), entry.name);
      assert.ok(doc.includes(entry.body), `${entry.name} body`);
    }
  });
});
