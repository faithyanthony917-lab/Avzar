import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { storefrontDocumentCatalog, validateStorefrontDocument } from '../src/auth/storefrontDocument.js';
import { hasStarter, sampleTemplateKeys, starterDocument, starterTemplateKeys } from '../src/auth/storefrontStarters.js';

const businessId = '00000000-0000-4000-8000-000000000002';

// Entitlement values per plan, as the seed gives them (Free, Starter, Professional, Business).
const plans = {
  free: { 'storefront.template_tier': 'standard', 'storefront.pages.max': '5', 'storefront.custom_pages': 'false', 'storefront.section_level': 'none', 'storefront.theme_level': 'none', 'storefront.branding_level': 'none', 'storefront.builder': 'false' },
  starter: { 'storefront.template_tier': 'basic', 'storefront.pages.max': '5', 'storefront.custom_pages': 'false', 'storefront.section_level': 'none', 'storefront.theme_level': 'basic', 'storefront.branding_level': 'basic', 'storefront.builder': 'false' },
  professional: { 'storefront.template_tier': 'advanced', 'storefront.pages.max': '12', 'storefront.custom_pages': 'true', 'storefront.section_level': 'advanced', 'storefront.theme_level': 'advanced', 'storefront.branding_level': 'advanced', 'storefront.builder': 'true' },
  business: { 'storefront.template_tier': 'premium', 'storefront.pages.max': '25', 'storefront.custom_pages': 'true', 'storefront.section_level': 'full', 'storefront.theme_level': 'full', 'storefront.branding_level': 'full', 'storefront.builder': 'true' },
};

function poolFor(plan) {
  return {
    async query(sql, values = []) {
      if (sql.includes('FROM "Plans" p')) return { rows: [{ Value: plans[plan][values[1]] }] };
      throw new Error(`Unexpected query: ${sql.slice(0, 60)}`);
    },
  };
}

const homeShape = (doc) => doc.pages.find((page) => page.kind === 'home').sections.map((item) => `${item.type}:${item.variant}`);
const minimumPlan = { standard: 'free', bespoke: 'starter', 'ready-to-wear': 'starter', luxury: 'professional', 'african-heritage': 'professional', bridal: 'professional', streetwear: 'business', 'atelier-studio': 'business' };

describe('storefront starter documents', () => {
  it('has its own starter for every template in the catalog', () => {
    assert.deepEqual([...starterTemplateKeys].sort(), Object.keys(storefrontDocumentCatalog.templates).sort());
    for (const key of Object.keys(storefrontDocumentCatalog.templates)) assert.equal(hasStarter(key), true, key);
    assert.equal(hasStarter('nope'), false);
  });

  it('offers a sample for every template except standard, which every plan includes', () => {
    assert.deepEqual([...sampleTemplateKeys].sort(), Object.keys(storefrontDocumentCatalog.templates).filter((key) => key !== 'standard').sort());
  });

  it('keeps the standard starter exactly as the old default site', () => {
    const doc = starterDocument('Atelier');
    assert.equal(doc.templateKey, 'standard');
    assert.equal(doc.theme.preset, 'clean-professional');
    assert.deepEqual(homeShape(doc), ['hero:centered', 'designList:grid', 'inquiryForm:minimal']);
    assert.deepEqual(doc.pages.map((page) => page.kind), ['home', 'catalog', 'design', 'about', 'contact']);
    assert.deepEqual(doc.navigation.map((item) => item.label), ['Home', 'Designs', 'About', 'Contact']);
  });

  it('gives each of the eight templates a different home page structure', () => {
    const keys = Object.keys(storefrontDocumentCatalog.templates);
    const shapes = keys.map((key) => homeShape(starterDocument('Atelier', key)).join('|'));
    assert.equal(new Set(shapes).size, keys.length);
    const types = keys.map((key) => homeShape(starterDocument('Atelier', key)).map((item) => item.split(':')[0]).join('|'));
    assert.equal(new Set(types).size, keys.length, 'the order of section types must differ, not only the layouts');
  });

  it('points opening buttons only at real pages or forms of the new site', () => {
    for (const key of starterTemplateKeys) {
      const doc = starterDocument('Atelier', key);
      const ids = new Set(doc.pages.map((item) => item.id));
      for (const item of doc.pages.flatMap((entry) => entry.sections)) {
        const target = item.props.buttonTarget;
        if (target !== undefined) assert.equal(ids.has(target) || target.startsWith('action:'), true, `${key}: ${target}`);
      }
    }
  });

  it('stores the chosen template and its own theme preset in the document', () => {
    for (const [key, definition] of Object.entries(storefrontDocumentCatalog.templates)) {
      const doc = starterDocument('Atelier', key);
      assert.equal(doc.templateKey, key);
      assert.equal(doc.theme.preset, definition.preset, `${key} preset`);
    }
  });

  it('rejects a template that does not exist', () => {
    assert.throws(() => starterDocument('Atelier', 'nope'), /Unknown storefront template/);
  });

  it('uses the shop name and never invents prices, quotes or photos', () => {
    for (const key of starterTemplateKeys) {
      const doc = starterDocument('Tara Tara', key);
      const text = JSON.stringify(doc);
      assert.match(text, /Tara Tara/);
      assert.equal(doc.pages.flatMap((page) => page.sections).some((item) => ['testimonials', 'pricing', 'gallery', 'services'].includes(item.type)), false, key);
      assert.equal(/MediaId":"/.test(text), false, `${key} must not reference media`);
    }
  });

  it('creates unique page and section ids on every call', () => {
    const first = starterDocument('Atelier', 'luxury');
    const second = starterDocument('Atelier', 'luxury');
    const ids = (doc) => doc.pages.flatMap((page) => [page.id, ...page.sections.map((item) => item.id)]);
    assert.equal(new Set(ids(first)).size, ids(first).length);
    assert.equal(ids(first).some((id) => ids(second).includes(id)), false);
  });

  for (const [key, plan] of Object.entries(minimumPlan)) {
    it(`${key} starter is valid and inside the ${plan} plan, so a new site never starts in violation`, async () => {
      const result = await validateStorefrontDocument(poolFor(plan), businessId, starterDocument('Atelier', key), { publish: true });
      assert.deepEqual(result.planIssues, []);
    });
  }

  it('every template, including those without their own starter yet, yields a document that validates on the top plan', async () => {
    for (const key of Object.keys(storefrontDocumentCatalog.templates)) {
      const result = await validateStorefrontDocument(poolFor('business'), businessId, starterDocument('Atelier', key), { publish: true });
      assert.deepEqual(result.planIssues, [], key);
    }
  });

  it('uses only the section types and layouts each template supports, on every page', () => {
    for (const [key, supported] of Object.entries(storefrontDocumentCatalog.templates)) {
      const doc = starterDocument('Atelier', key);
      for (const item of doc.pages.flatMap((page) => page.sections)) {
        assert.equal(supported[item.type]?.includes(item.variant), true, `${key}: ${item.type}:${item.variant}`);
      }
      assert.equal(doc.templateKey, key);
    }
  });

  it('refuses the luxury starter on a plan below its template tier', async () => {
    await assert.rejects(
      validateStorefrontDocument(poolFor('starter'), businessId, starterDocument('Atelier', 'luxury'), { publish: true }),
      (error) => error.code === 'plan_violations' || error.status === 403,
    );
  });
});
