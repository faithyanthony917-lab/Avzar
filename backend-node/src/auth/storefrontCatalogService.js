import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { entitlementValue, requireFlag } from './entitlementService.js';
import { withTransaction } from './accountService.js';
import { validatePresetSection, storefrontDocumentCatalog } from './storefrontDocument.js';
import { resolveTheme } from './publicSiteRoutes.js';
import { sampleTemplateKeys } from './storefrontStarters.js';

const templateNames = {
  standard: ['Standard', 'A clean, simple catalog site. Included in every plan.'],
  bespoke: ['Bespoke tailoring', 'Process-led and personal: ideal for suits and made-to-measure by appointment.'],
  'ready-to-wear': ['Ready-to-wear', 'A shop-style layout with a dense product grid and clear prices.'],
  luxury: ['Luxury fashion', 'Dark, editorial and spacious: for high-end labels and couture.'],
  'african-heritage': ['African fashion', 'Warm, pattern-friendly and story-led: for Ankara, Aso-oke and heritage designers.'],
  bridal: ['Bridal fashion', 'Soft, photo-led and consultation-first: for gowns, bridal parties and occasions.'],
  streetwear: ['Streetwear', 'Loud, fast and product-first: for drops, merch and casual labels.'],
  'atelier-studio': ['Atelier studio', 'Designer-led and service-rich: for studios selling their craft, process and pricing.'],
};
// Gallery order shown to shop owners; a template not listed here goes last, in its catalog order.
const galleryOrder = ['standard', 'bespoke', 'african-heritage', 'luxury', 'ready-to-wear', 'bridal', 'streetwear', 'atelier-studio'];
const galleryRank = (key) => { const index = galleryOrder.indexOf(key); return index < 0 ? galleryOrder.length : index; };
const sectionLabels = {
  hero: 'Hero banner', designList: 'Design listing', about: 'About', contactInfo: 'Contact information',
  inquiryForm: 'Inquiry form', richText: 'Text block', gallery: 'Image gallery', collection: 'Collection',
  featuredDesigns: 'Featured designs', services: 'Services', designerProfile: 'Designer profile',
  testimonials: 'Testimonials', pricing: 'Pricing', faq: 'FAQ', booking: 'Appointment booking', customOrderForm: 'Custom-order form',
};
const presetStyle = (align = 'left') => ({ background: null, backgroundMediaId: null, align, spacing: 'comfortable', textColor: null, buttonShape: null });
const preset = (key, name, sectionType, variant, props, align = 'left') => ({ key, name, sectionType, variant, props, style: presetStyle(align), isBuiltIn: true });
const builtInPresets = [
  preset('hero-centered-cta', 'Hero: centered with button', 'hero', 'centered', { headline: 'Made for you', subheadline: 'Clothing cut to your measurements.', buttonLabel: 'Get in touch', buttonTarget: 'action:inquiry' }, 'center'),
  preset('hero-minimal', 'Hero: minimal', 'hero', 'minimal', { headline: 'Tailoring with care' }),
  preset('about-story', 'About: our story', 'about', 'split', { heading: 'Our story', body: 'Tell visitors where you started, what you care about and how you work.' }),
  preset('faq-basics', 'FAQ: common questions', 'faq', 'accordion', { heading: 'Questions we hear a lot', items: [
    { question: 'How long does an order take?', answer: 'Add your usual lead time here.' },
    { question: 'Do you do alterations?', answer: 'Add your alteration policy here.' },
    { question: 'How do I pay?', answer: 'Explain deposits and payment methods.' },
  ] }),
  preset('testimonials-trio', 'Testimonials: three quotes', 'testimonials', 'cards', { heading: 'What customers say', items: [
    { quote: "Add a customer's words here.", author: 'Customer name', role: '' },
    { quote: 'Another happy customer.', author: 'Customer name', role: '' },
    { quote: 'A third quote.', author: 'Customer name', role: '' },
  ] }, 'center'),
  preset('services-three', 'Services: three offers', 'services', 'cards', { heading: 'What we do', items: [
    { title: 'Made-to-measure', description: 'Cut and sewn for you.', priceText: 'From on request' },
    { title: 'Alterations', description: 'Fit and repair.', priceText: '' },
    { title: 'Occasion wear', description: 'For weddings and events.', priceText: '' },
  ] }),
  preset('pricing-simple', 'Pricing: two options', 'pricing', 'cards', { heading: 'Pricing', tiers: [
    { name: 'Alteration', price: 'From 0', features: ['Quick turnaround'], highlight: false },
    { name: 'Made-to-measure', price: 'On request', features: ['Consultation', 'Fittings included'], highlight: true },
  ] }),
  preset('booking-simple', 'Booking: request a fitting', 'booking', 'simple', { heading: 'Book a fitting', intro: 'Choose a day and we will confirm it.' }),
];

function propDto(name, spec) {
  return {
    name, kind: spec.kind, max: spec.max ?? 0, min: spec.min ?? 0, required: Boolean(spec.required),
    multiline: Boolean(spec.multiline), itemMax: spec.itemMax ?? 0,
    fields: spec.fields ? Object.entries(spec.fields).map(([child, value]) => propDto(child, value)) : null,
  };
}

async function limit(db, businessId, key) {
  const raw = await entitlementValue(db, businessId, key, '0');
  if (raw === 'unlimited') return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError(503, 'plans_not_seeded', 'The plan limit is not configured correctly.');
  return value;
}

export async function getStorefrontBuilderCatalog(pool, user) {
  const businessId = user.businessId;
  const keys = ['storefront.builder', 'storefront.theme_level', 'storefront.branding_level', 'storefront.section_level',
    'storefront.template_tier', 'storefront.custom_pages', 'storefront.custom_domain'];
  const values = Object.fromEntries(await Promise.all(keys.map(async (key) => [key,
    await entitlementValue(pool, businessId, key, key === 'storefront.template_tier' ? 'standard' : key.includes('_level') ? 'none' : 'false')])));
  const [maxPages, maxStorefronts, customRows] = await Promise.all([
    limit(pool, businessId, 'storefront.pages.max'), limit(pool, businessId, 'storefront.count.max'),
    pool.query('SELECT "Id", "Name", "SectionType", "Variant", "PropsJson", "StyleJson" FROM "SectionPresets" WHERE "BusinessId" = $1 ORDER BY "Name"', [businessId]),
  ]);
  const tierOrder = storefrontDocumentCatalog.tiers;
  const currentTier = tierOrder.indexOf(values['storefront.template_tier']);
  const allowed = (tier) => currentTier >= 0 && currentTier >= tierOrder.indexOf(tier);
  const advanced = storefrontDocumentCatalog.levels.indexOf(values['storefront.section_level']) >= 2;
  const templates = Object.entries(storefrontDocumentCatalog.templates).map(([key, definition]) => ({
    key, name: templateNames[key][0], description: templateNames[key][1], tier: definition.tier,
    defaultPreset: definition.preset, allowed: allowed(definition.tier), sample: sampleTemplateKeys.includes(key), supported: Object.fromEntries(Object.entries(definition).filter(([name]) => !['tier', 'preset'].includes(name))),
  }));
  templates.sort((a, b) => galleryRank(a.key) - galleryRank(b.key));
  const themes = Object.entries(storefrontDocumentCatalog.themePresets).map(([key, definition]) => {
    const resolved = resolveTheme({ preset: key });
    const names = { 'modern-luxury': 'Modern luxury', minimalist: 'Minimalist', elegant: 'Elegant', 'bold-contemporary': 'Bold contemporary', 'african-heritage': 'Traditional African fashion', 'clean-professional': 'Clean professional' };
    return { key, name: names[key], colors: resolved.colors, headingFont: resolved.headingFont, bodyFont: resolved.bodyFont };
  });
  const allVariants = Object.fromEntries(Object.keys(storefrontDocumentCatalog.sectionTypes).map((type) => [type,
    [...new Set(Object.values(storefrontDocumentCatalog.templates).flatMap((template) => template[type] ?? []))]]));
  const sectionTypes = Object.entries(storefrontDocumentCatalog.sectionTypes).map(([type, definition]) => ({
    type, label: sectionLabels[type], minLevel: definition.min, variants: allVariants[type],
    allowed: definition.min === 'basic' || advanced, props: Object.entries(definition.props).map(([name, spec]) => propDto(name, spec)),
  }));
  const savedPresets = customRows.rows.map((row) => ({
    key: row.Id, name: row.Name, sectionType: row.SectionType, variant: row.Variant,
    props: typeof row.PropsJson === 'string' ? JSON.parse(row.PropsJson) : row.PropsJson,
    style: typeof row.StyleJson === 'string' ? JSON.parse(row.StyleJson) : row.StyleJson, isBuiltIn: false,
  }));
  return {
    templates, themes, fonts: storefrontDocumentCatalog.fonts, sectionTypes, presets: [...builtInPresets, ...savedPresets],
    capabilities: {
      builder: values['storefront.builder'] === 'true', themeLevel: values['storefront.theme_level'],
      brandingLevel: values['storefront.branding_level'], sectionLevel: values['storefront.section_level'],
      templateTier: values['storefront.template_tier'], customPages: values['storefront.custom_pages'] === 'true',
      customDomain: values['storefront.custom_domain'] === 'true', maxPages, maxStorefronts,
    },
  };
}

export async function createSectionPreset(pool, user, request) {
  await requireFlag(pool, user.businessId, 'storefront.builder');
  const section = { type: request.sectionType, variant: request.variant, props: request.props, style: request.style ?? presetStyle() };
  validatePresetSection(section);
  const sectionLevel = await entitlementValue(pool, user.businessId, 'storefront.section_level', 'none');
  if (storefrontDocumentCatalog.levels.indexOf(sectionLevel) < 0
      || (sectionLevel !== 'full' && storefrontDocumentCatalog.sectionTypes[section.type].min === 'advanced' && sectionLevel !== 'advanced')) {
    throw AppError.forbidden('feature_not_in_plan', 'That kind of section is not included in your plan.');
  }
  return withTransaction(pool, async (client) => {
    const { rows: count } = await client.query('SELECT count(*)::int AS "Count" FROM "SectionPresets" WHERE "BusinessId" = $1', [user.businessId]);
    if (count[0].Count >= 50) throw AppError.conflict('too_many_presets', 'You can save up to 50 presets.');
    const { rows: duplicate } = await client.query('SELECT 1 FROM "SectionPresets" WHERE "BusinessId" = $1 AND lower("Name") = lower($2)', [user.businessId, request.name.trim()]);
    if (duplicate.length) throw AppError.conflict('preset_exists', 'You already have a preset with this name.');
    const id = randomUUID();
    const style = { ...presetStyle(), ...section.style };
    await client.query(
      `INSERT INTO "SectionPresets" ("Id", "BusinessId", "Name", "SectionType", "Variant", "PropsJson", "StyleJson", "CreatedByUserId", "CreatedAtUtc")
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,now())`,
      [id, user.businessId, request.name.trim(), section.type, section.variant, JSON.stringify(section.props), JSON.stringify(style), user.userId]);
    await client.query(
      `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","EntityId","EntityType")
       VALUES ($1,'storefront.preset_created',$2,$3,now(),$4,'SectionPreset')`, [randomUUID(), user.userId, user.businessId, id]);
    return { key: id, name: request.name.trim(), sectionType: section.type, variant: section.variant, props: section.props, style, isBuiltIn: false };
  });
}

export async function deleteSectionPreset(pool, user, id) {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query('DELETE FROM "SectionPresets" WHERE "Id" = $1 AND "BusinessId" = $2 RETURNING "Name"', [id, user.businessId]);
    if (!rows[0]) throw AppError.notFound('preset_not_found', 'Preset not found.');
    await client.query(
      `INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","EntityId","EntityType")
       VALUES ($1,'storefront.preset_deleted',$2,$3,now(),$4,'SectionPreset')`, [randomUUID(), user.userId, user.businessId, id]);
  });
}