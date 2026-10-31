import { AppError } from '../http/errors.js';
import { entitlementValue } from './entitlementService.js';

const tiers = ['standard', 'basic', 'advanced', 'premium'];
const levels = ['none', 'basic', 'advanced', 'full'];
const colors = ['primary', 'secondary', 'accent', 'background', 'text', 'heading', 'button', 'buttonText', 'nav', 'navText', 'footer', 'footerText', 'card', 'border'];
const fonts = ['Playfair Display', 'Cormorant Garamond', 'DM Serif Display', 'Cinzel', 'Libre Baskerville', 'Abril Fatface', 'Lora', 'Merriweather', 'Montserrat', 'Poppins', 'Inter', 'Raleway', 'Josefin Sans', 'Work Sans', 'Nunito', 'Lato', 'Open Sans', 'DM Sans', 'Source Sans 3', 'Bebas Neue', 'Oswald', 'Space Grotesk'];
const themePresets = ['modern-luxury', 'minimalist', 'elegant', 'bold-contemporary', 'african-heritage', 'clean-professional'];
const pageKinds = ['home', 'catalog', 'design', 'about', 'services', 'contact', 'custom'];
const reservedPageSlugs = ['collection', 'api', 'public', '_next', 'sitemap', 'robots', 'inquiry', 'admin'];
const actions = ['action:inquiry', 'action:booking', 'action:custom-order', 'action:contact'];
const templates = {
  standard: { tier: 'standard', preset: 'clean-professional', hero: ['centered', 'minimal'], designList: ['grid', 'list'], about: ['simple'], contactInfo: ['simple'], inquiryForm: ['minimal'], richText: ['simple'] },
  bespoke: { tier: 'basic', preset: 'elegant', hero: ['minimal', 'centered', 'split-right'], about: ['split', 'simple'], designList: ['list', 'editorial'], contactInfo: ['split', 'simple'], inquiryForm: ['split', 'minimal'], richText: ['narrow', 'simple'] },
  'ready-to-wear': { tier: 'basic', preset: 'minimalist', hero: ['centered', 'fullbleed'], designList: ['grid', 'dense-grid', 'editorial'], about: ['simple'], contactInfo: ['simple'], inquiryForm: ['minimal'], richText: ['simple'] },
  luxury: { tier: 'advanced', preset: 'modern-luxury', hero: ['fullbleed', 'minimal', 'centered'], featuredDesigns: ['editorial', 'spotlight'], designList: ['editorial', 'grid'], designerProfile: ['split', 'large'], testimonials: ['quotes', 'slider'], gallery: ['filmstrip', 'grid'], services: ['list'], about: ['split'], contactInfo: ['split'], inquiryForm: ['minimal', 'split'], booking: ['split'], richText: ['narrow'], faq: ['accordion'] },
  'african-heritage': { tier: 'advanced', preset: 'african-heritage', hero: ['split-right', 'split-left', 'centered'], collection: ['mosaic', 'cards'], gallery: ['masonry', 'grid'], services: ['cards', 'columns'], testimonials: ['cards'], designList: ['grid', 'editorial'], designerProfile: ['centered', 'split'], booking: ['simple', 'split'], about: ['split', 'simple'], contactInfo: ['simple', 'split'], inquiryForm: ['minimal', 'split'], faq: ['two-column', 'accordion'], richText: ['simple'], customOrderForm: ['simple', 'split'], featuredDesigns: ['row'] },
  bridal: { tier: 'advanced', preset: 'elegant', hero: ['split-left', 'centered', 'fullbleed'], gallery: ['carousel', 'grid'], collection: ['lookbook', 'cards'], testimonials: ['slider', 'cards'], booking: ['split', 'simple'], faq: ['accordion'], services: ['list', 'cards'], pricing: ['cards', 'table'], designerProfile: ['centered', 'split'], about: ['split', 'simple'], designList: ['editorial', 'grid'], contactInfo: ['split'], inquiryForm: ['split'], customOrderForm: ['split'], richText: ['narrow'], featuredDesigns: ['spotlight', 'row'] },
  streetwear: { tier: 'premium', preset: 'bold-contemporary', hero: ['fullbleed', 'minimal'], designList: ['dense-grid', 'grid'], gallery: ['filmstrip', 'masonry', 'grid'], collection: ['strip', 'mosaic'], featuredDesigns: ['row', 'spotlight'], inquiryForm: ['minimal'], contactInfo: ['simple'], richText: ['simple'], about: ['simple'], faq: ['two-column'], customOrderForm: ['simple'] },
  'atelier-studio': { tier: 'premium', preset: 'minimalist', designerProfile: ['large', 'split', 'centered'], gallery: ['grid', 'masonry'], services: ['list', 'columns'], pricing: ['table', 'cards'], testimonials: ['quotes', 'cards'], customOrderForm: ['split', 'simple'], booking: ['split', 'simple'], hero: ['minimal', 'split-left', 'centered'], about: ['split'], contactInfo: ['split'], inquiryForm: ['split'], faq: ['accordion', 'two-column'], designList: ['editorial', 'list'], collection: ['cards', 'lookbook'], featuredDesigns: ['editorial'], richText: ['narrow', 'simple'] },
};

const T = (max, required = false, multiline = false) => ({ kind: 'Text', max, required, multiline });
const B = () => ({ kind: 'Bool' });
const I = (min, max) => ({ kind: 'Int', min, max });
const G = () => ({ kind: 'Guid' });
const Lk = () => ({ kind: 'Link' });
const L = (max, fields) => ({ kind: 'List', max, fields });
const SL = (max, itemMax) => ({ kind: 'StringList', max, itemMax });
const sectionTypes = {
  hero: { min: 'basic', variants: ['centered', 'split-left', 'split-right', 'fullbleed', 'minimal'], props: { headline: T(120, true), subheadline: T(300), imageMediaId: G(), buttonLabel: T(30), buttonTarget: Lk() } },
  designList: { min: 'basic', variants: ['grid', 'dense-grid', 'list', 'editorial'], props: { heading: T(80), categoryId: G(), featuredOnly: B(), limit: I(1, 48), showPrices: B() } },
  about: { min: 'basic', variants: ['simple', 'split'], props: { heading: T(80), body: T(3000, false, true), imageMediaId: G() } },
  contactInfo: { min: 'basic', variants: ['simple', 'split'], props: { heading: T(80), showAddress: B(), showPhone: B(), showEmail: B(), showHours: B(), note: T(300) } },
  inquiryForm: { min: 'basic', variants: ['minimal', 'split'], props: { heading: T(80), intro: T(400, false, true) } },
  richText: { min: 'basic', variants: ['simple', 'narrow'], props: { heading: T(80), body: T(4000, false, true) } },
  gallery: { min: 'advanced', variants: ['grid', 'masonry', 'carousel', 'filmstrip'], props: { heading: T(80), columns: I(2, 5), images: L(24, { mediaId: G(), alt: T(200), caption: T(100) }) } },
  collection: { min: 'advanced', variants: ['mosaic', 'strip', 'lookbook', 'cards'], props: { heading: T(80), collectionId: G(), limit: I(1, 24), showPrices: B() } },
  featuredDesigns: { min: 'advanced', variants: ['editorial', 'row', 'spotlight'], props: { heading: T(80), limit: I(1, 12), showPrices: B() } },
  services: { min: 'advanced', variants: ['cards', 'list', 'columns'], props: { heading: T(80), items: L(12, { title: T(60, true), description: T(300), priceText: T(40) }) } },
  designerProfile: { min: 'advanced', variants: ['split', 'centered', 'large'], props: { name: T(80, true), role: T(80), bio: T(1500, false, true), imageMediaId: G() } },
  testimonials: { min: 'advanced', variants: ['cards', 'quotes', 'slider'], props: { heading: T(80), items: L(12, { quote: T(400, true), author: T(60), role: T(60) }) } },
  pricing: { min: 'advanced', variants: ['table', 'cards'], props: { heading: T(80), tiers: L(6, { name: T(60, true), price: T(40), features: SL(8, 80), highlight: B() }) } },
  faq: { min: 'advanced', variants: ['accordion', 'two-column'], props: { heading: T(80), items: L(20, { question: T(200, true), answer: T(1000, true, true) }) } },
  booking: { min: 'advanced', variants: ['simple', 'split'], props: { heading: T(80), intro: T(400, false, true) } },
  customOrderForm: { min: 'advanced', variants: ['simple', 'split'], props: { heading: T(80), intro: T(400, false, true) } },
};

export const storefrontDocumentCatalog = { templates, sectionTypes, fonts, themePresets, tiers, levels };

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hexPattern = /^#[0-9a-f]{6}$/i;
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const https = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !/[\s<>\u0000-\u001f]/.test(value) && value.length <= 200; }
  catch { return false; }
};

function checkObject(path, value, schema, errors, refs, pageIds = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push({ path, message: 'Expected an object.' }); return; }
  for (const key of Object.keys(value)) if (!(key in schema)) errors.push({ path: `${path}.${key}`, message: 'Unknown property.' });
  for (const [key, spec] of Object.entries(schema)) {
    const current = value[key];
    if (spec.required && (current === undefined || current === null || (typeof current === 'string' && !current.trim()))) errors.push({ path: `${path}.${key}`, message: 'This field is required.' });
    if (current === undefined || current === null) continue;
    if (spec.kind === 'Text') {
      if (typeof current !== 'string') errors.push({ path: `${path}.${key}`, message: 'Expected text.' });
      else {
        if (current.length > spec.max) errors.push({ path: `${path}.${key}`, message: `At most ${spec.max} characters.` });
        if (/[<>]/.test(current)) errors.push({ path: `${path}.${key}`, message: 'The characters < and > are not allowed.' });
        if ([...current].some((char) => char.charCodeAt(0) < 32 && !(spec.multiline && ['\n', '\r'].includes(char)))) errors.push({ path: `${path}.${key}`, message: 'Control characters are not allowed.' });
      }
    } else if (spec.kind === 'Bool') {
      if (typeof current !== 'boolean') errors.push({ path: `${path}.${key}`, message: 'Expected true or false.' });
    } else if (spec.kind === 'Int') {
      if (!Number.isInteger(current)) errors.push({ path: `${path}.${key}`, message: 'Expected a whole number.' });
      else if (current < spec.min || current > spec.max) errors.push({ path: `${path}.${key}`, message: `Must be between ${spec.min} and ${spec.max}.` });
    } else if (spec.kind === 'Guid') {
      if (typeof current !== 'string' || !idPattern.test(current)) errors.push({ path: `${path}.${key}`, message: 'Expected an id.' });
      else if (key.endsWith('MediaId') || key === 'mediaId') refs.media.add(current);
      else if (key === 'collectionId') refs.collections.add(current);
      else if (key === 'categoryId') refs.categories.add(current);
    } else if (spec.kind === 'Link') {
      if (typeof current !== 'string' || !(actions.includes(current) || (pageIds?.has(current)) || https(current))) errors.push({ path: `${path}.${key}`, message: 'A link must point to a page of this site, a form, or a full https:// address.' });
    } else if (spec.kind === 'List') {
      if (!Array.isArray(current)) errors.push({ path: `${path}.${key}`, message: 'Expected a list.' });
      else {
        if (current.length > spec.max) errors.push({ path: `${path}.${key}`, message: `At most ${spec.max} items.` });
        current.forEach((item, index) => checkObject(`${path}.${key}[${index}]`, item, spec.fields, errors, refs, pageIds));
      }
    } else if (spec.kind === 'StringList') {
      if (!Array.isArray(current)) errors.push({ path: `${path}.${key}`, message: 'Expected a list of text.' });
      else {
        if (current.length > spec.max) errors.push({ path: `${path}.${key}`, message: `At most ${spec.max} items.` });
        current.forEach((item, index) => {
          if (typeof item !== 'string') errors.push({ path: `${path}.${key}[${index}]`, message: 'Expected text.' });
          else if (item.length > spec.itemMax || /[<>]/.test(item)) errors.push({ path: `${path}.${key}[${index}]`, message: `Text must be plain and at most ${spec.itemMax} characters.` });
        });
      }
    }
  }
}

function text(errors, path, value, max, required = false, multiline = false) {
  if (value === null || value === undefined || value === '') { if (required) errors.push({ path, message: 'This field is required.' }); return; }
  if (typeof value !== 'string') { errors.push({ path, message: 'Expected text.' }); return; }
  if (required && !value.trim()) errors.push({ path, message: 'This field is required.' });
  if (value.length > max) errors.push({ path, message: `At most ${max} characters.` });
  if (/[<>]/.test(value)) errors.push({ path, message: 'The characters < and > are not allowed.' });
  if ([...value].some((char) => char.charCodeAt(0) < 32 && !(multiline && ['\n', '\r'].includes(char)))) errors.push({ path, message: 'Control characters are not allowed.' });
}

function documentErrors(doc) {
  const errors = [];
  const refs = { media: new Set(), collections: new Set(), categories: new Set() };
  const template = templates[doc?.templateKey];
  if (!Number.isInteger(doc?.schemaVersion) || doc.schemaVersion !== 1) errors.push({ path: 'schemaVersion', message: 'Unsupported storefront schema version.' });
  if (!template) errors.push({ path: 'templateKey', message: `Unknown template '${doc?.templateKey}'.` });
  if (!doc?.theme || typeof doc.theme !== 'object' || Array.isArray(doc.theme)) errors.push({ path: 'theme', message: 'Expected an object.' });
  else {
    if (!themePresets.includes(doc.theme.preset)) errors.push({ path: 'theme.preset', message: `Unknown theme '${doc.theme.preset}'.` });
    if (doc.theme.colors && typeof doc.theme.colors === 'object' && !Array.isArray(doc.theme.colors)) {
      for (const [key, value] of Object.entries(doc.theme.colors)) {
        if (!colors.includes(key)) errors.push({ path: `theme.colors.${key}`, message: 'Unknown colour name.' });
        else if (typeof value !== 'string' || !hexPattern.test(value)) errors.push({ path: `theme.colors.${key}`, message: 'Colours must look like #1A2B3C.' });
      }
    }
    for (const key of ['headingFont', 'bodyFont']) if (doc.theme[key] != null && !fonts.includes(doc.theme[key])) errors.push({ path: `theme.${key}`, message: 'That font is not available.' });
    if (doc.theme.headingStyle != null && !['normal', 'uppercase', 'italic'].includes(doc.theme.headingStyle)) errors.push({ path: 'theme.headingStyle', message: 'Unknown heading style.' });
    if (doc.theme.buttonShape != null && !['square', 'rounded', 'pill'].includes(doc.theme.buttonShape)) errors.push({ path: 'theme.buttonShape', message: 'Unknown button shape.' });
    if (doc.theme.radius != null && (!Number.isInteger(doc.theme.radius) || doc.theme.radius < 0 || doc.theme.radius > 32)) errors.push({ path: 'theme.radius', message: 'Corner radius must be between 0 and 32.' });
    if (doc.theme.sectionSpacing != null && !['compact', 'comfortable', 'spacious'].includes(doc.theme.sectionSpacing)) errors.push({ path: 'theme.sectionSpacing', message: 'Unknown spacing.' });
  }
  const branding = doc?.branding;
  if (!branding || typeof branding !== 'object' || Array.isArray(branding)) errors.push({ path: 'branding', message: 'Expected an object.' });
  else {
    for (const key of ['logoMediaId', 'faviconMediaId', 'shareImageMediaId']) if (branding[key] != null) {
      if (typeof branding[key] !== 'string' || !idPattern.test(branding[key])) errors.push({ path: `branding.${key}`, message: 'Expected an id.' });
      else refs.media.add(branding[key]);
    }
    if (!Number.isInteger(branding.logoWidth) || branding.logoWidth < 40 || branding.logoWidth > 400) errors.push({ path: 'branding.logoWidth', message: 'Logo width must be between 40 and 400.' });
    if (!['left', 'center'].includes(branding.logoPlacement)) errors.push({ path: 'branding.logoPlacement', message: 'Unknown logo placement.' });
    text(errors, 'branding.tagline', branding.tagline, 100);
    text(errors, 'branding.footerText', branding.footerText, 300, false, true);
    if (!Array.isArray(branding.socialLinks) || branding.socialLinks.length > 6) errors.push({ path: 'branding.socialLinks', message: 'At most 6 social links.' });
    for (const [index, link] of (branding.socialLinks ?? []).entries()) {
      if (!['instagram', 'facebook', 'tiktok', 'x', 'youtube', 'pinterest', 'whatsapp', 'linkedin'].includes(link.network)) errors.push({ path: `branding.socialLinks[${index}].network`, message: 'Unknown network.' });
      if (!https(link.url)) errors.push({ path: `branding.socialLinks[${index}].url`, message: 'Social links must be full https:// addresses.' });
    }
  }
  const pages = doc?.pages;
  if (!Array.isArray(pages) || pages.length === 0 || pages.length > 30) errors.push({ path: 'pages', message: 'A site needs 1 to 30 pages.' });
  const pageIds = new Set();
  const slugs = new Set();
  const kinds = new Map();
  for (const page of pages ?? []) {
    if (!page || typeof page !== 'object') continue;
    if (typeof page.id !== 'string' || !idPattern.test(page.id) || pageIds.has(page.id)) errors.push({ path: 'pages', message: 'Every page needs a unique id.' });
    pageIds.add(page.id);
    if (!pageKinds.includes(page.kind)) errors.push({ path: 'pages', message: `Unknown page kind '${page.kind}'.` });
    kinds.set(page.kind, (kinds.get(page.kind) ?? 0) + 1);
  }
  for (const kind of ['home', 'catalog', 'design', 'about', 'services', 'contact']) if ((kinds.get(kind) ?? 0) > 1) errors.push({ path: 'pages', message: `There can be only one '${kind}' page.` });
  if (kinds.get('home') !== 1) errors.push({ path: 'pages', message: 'A site needs exactly one home page.' });
  const sectionIds = new Set();
  for (const [pageIndex, page] of (pages ?? []).entries()) {
    const path = `pages[${pageIndex}]`;
    if (page.kind === 'home' ? page.slug !== '' : typeof page.slug !== 'string' || page.slug.length < 1 || page.slug.length > 40 || !slugPattern.test(page.slug)) errors.push({ path: `${path}.slug`, message: 'The page slug is invalid.' });
    else if (reservedPageSlugs.includes(page.slug)) errors.push({ path: `${path}.slug`, message: `'${page.slug}' is reserved.` });
    else if (slugs.has(page.slug)) errors.push({ path: `${path}.slug`, message: 'Two pages share the same slug.' });
    else slugs.add(page.slug);
    text(errors, `${path}.title`, page.title, 80, true);
    if (!page.seo || typeof page.seo !== 'object') errors.push({ path: `${path}.seo`, message: 'Expected an object.' });
    else {
      text(errors, `${path}.seo.title`, page.seo.title, 70);
      text(errors, `${path}.seo.description`, page.seo.description, 160);
      if (page.seo.shareImageMediaId) refs.media.add(page.seo.shareImageMediaId);
    }
    if (!Array.isArray(page.sections) || page.sections.length > 40) errors.push({ path: `${path}.sections`, message: 'At most 40 sections per page.' });
    for (const [sectionIndex, section] of (page.sections ?? []).entries()) {
      const sectionPath = `${path}.sections[${sectionIndex}]`;
      if (!section || typeof section !== 'object') continue;
      if (typeof section.id !== 'string' || !idPattern.test(section.id) || sectionIds.has(section.id)) errors.push({ path: `${sectionPath}.id`, message: 'Every section needs a unique id.' });
      sectionIds.add(section.id);
      const definition = sectionTypes[section.type];
      if (!definition) { errors.push({ path: `${sectionPath}.type`, message: `Unknown section type '${section.type}'.` }); continue; }
      const supported = template?.[section.type];
      if (!supported) errors.push({ path: `${sectionPath}.type`, message: `The selected template does not support '${section.type}' sections.` });
      else if (!supported.includes(section.variant)) errors.push({ path: `${sectionPath}.variant`, message: `'${section.variant}' is not available for ${section.type} in this template.` });
      const style = section.style ?? {};
      for (const key of ['background', 'textColor']) if (style[key] != null && !hexPattern.test(style[key])) errors.push({ path: `${sectionPath}.style.${key}`, message: 'Colours must look like #1A2B3C.' });
      if (!['left', 'center', 'right'].includes(style.align)) errors.push({ path: `${sectionPath}.style.align`, message: 'Unknown alignment.' });
      if (!['compact', 'comfortable', 'spacious'].includes(style.spacing)) errors.push({ path: `${sectionPath}.style.spacing`, message: 'Unknown spacing.' });
      if (style.buttonShape != null && !['square', 'rounded', 'pill'].includes(style.buttonShape)) errors.push({ path: `${sectionPath}.style.buttonShape`, message: 'Unknown button shape.' });
      if (style.backgroundMediaId) refs.media.add(style.backgroundMediaId);
      checkObject(`${sectionPath}.props`, section.props, definition.props, errors, refs, pageIds);
    }
  }
  if (!Array.isArray(doc?.navigation) || doc.navigation.length > 12) errors.push({ path: 'navigation', message: 'At most 12 menu items.' });
  const navPages = new Set();
  for (const [index, item] of (doc?.navigation ?? []).entries()) {
    text(errors, `navigation[${index}].label`, item.label, 30, true);
    if (!pageIds.has(item.pageId)) errors.push({ path: `navigation[${index}].pageId`, message: 'The menu item points to a page that does not exist.' });
    else if (navPages.has(item.pageId)) errors.push({ path: `navigation[${index}].pageId`, message: 'A page can appear in the menu only once.' });
    navPages.add(item.pageId);
  }
  if (!Array.isArray(doc?.archive) || doc.archive.length > 100) errors.push({ path: 'archive', message: 'At most 100 archived sections.' });
  return { errors, refs, template };
}

function planViolations(doc, entitlements, template) {
  const issues = [];
  const tierAtLeast = (key, minimum, fallback) => {
    const current = entitlements[key] ?? fallback;
    return tiers.indexOf(current) >= tiers.indexOf(minimum);
  };
  if (template && !tierAtLeast('storefront.template_tier', template.tier, 'standard')) issues.push({ code: 'template_tier', message: 'This template is not included in your plan.' });
  const maxPages = entitlements['storefront.pages.max'] ?? '0';
  if (maxPages !== 'unlimited' && Number(maxPages) < doc.pages.length) issues.push({ code: 'pages_max', message: `Your plan allows ${maxPages} page(s); this site has ${doc.pages.length}.` });
  if (doc.pages.some((page) => page.kind === 'custom') && entitlements['storefront.custom_pages'] !== 'true') issues.push({ code: 'custom_pages', message: 'Custom pages are not included in your plan.' });
  const advanced = levels.indexOf(entitlements['storefront.section_level'] ?? 'none') >= levels.indexOf('advanced');
  const fullSections = entitlements['storefront.section_level'] === 'full';
  for (const section of doc.pages.flatMap((page) => page.sections)) {
    const definition = sectionTypes[section.type];
    if (!advanced && definition?.min === 'advanced') issues.push({ code: `section:${section.type}`, message: `'${section.type}' sections are not included in your plan.` });
    if (!advanced && (section.style.background != null || section.style.textColor != null || section.style.backgroundMediaId != null)) issues.push({ code: 'section_style', message: 'Section colours and backgrounds are not included in your plan.' });
    if (!fullSections && section.style.buttonShape != null) issues.push({ code: 'section_button_shape', message: 'Per-section button styles are not included in your plan.' });
  }
  const theme = doc.theme;
  const themeLevel = levels.indexOf(entitlements['storefront.theme_level'] ?? 'none');
  if (themeLevel < 1 && template && theme.preset !== template.preset) issues.push({ code: 'theme_preset', message: 'Choosing a different theme is not included in your plan.' });
  for (const key of Object.keys(theme.colors ?? {})) if (themeLevel < 1 || (themeLevel < 2 && !['primary', 'accent'].includes(key))) issues.push({ code: `theme_color:${key}`, message: 'Changing theme colours is not included in your plan.' });
  if (themeLevel < 2 && theme.headingFont != null) issues.push({ code: 'theme_font:heading', message: 'Choosing fonts is not included in your plan.' });
  if (themeLevel < 2 && theme.bodyFont != null) issues.push({ code: 'theme_font:body', message: 'Choosing fonts is not included in your plan.' });
  if (themeLevel < 3) for (const key of ['headingStyle', 'buttonShape', 'radius', 'sectionSpacing']) if (theme[key] != null) issues.push({ code: `theme_style:${key}`, message: 'This theme setting needs a higher plan.' });
  const branding = doc.branding;
  const brandLevel = levels.indexOf(entitlements['storefront.branding_level'] ?? 'none');
  if (brandLevel < 1) for (const [field, code] of [['logoMediaId', 'branding_logo'], ['faviconMediaId', 'branding_favicon'], ['footerText', 'branding_footer']]) if (branding[field] != null) issues.push({ code, message: 'Branding is not included in your plan.' });
  if (brandLevel < 2) {
    if (branding.shareImageMediaId != null || doc.pages.some((page) => page.seo.shareImageMediaId != null)) issues.push({ code: 'branding_share', message: 'Share images are not included in your plan.' });
    if ((branding.socialLinks ?? []).length || branding.logoWidth !== 120 || branding.logoPlacement !== 'left') issues.push({ code: 'branding_advanced', message: 'Advanced branding is not included in your plan.' });
  }
  if (brandLevel < 3 && branding.tagline != null) issues.push({ code: 'branding_tagline', message: 'A tagline is not included in your plan.' });
  return issues;
}

async function getEntitlements(pool, businessId) {
  const keys = ['storefront.template_tier', 'storefront.pages.max', 'storefront.custom_pages', 'storefront.section_level',
    'storefront.theme_level', 'storefront.branding_level', 'storefront.builder'];
  const pairs = await Promise.all(keys.map(async (key) => [key, await entitlementValue(pool, businessId, key, key.endsWith('.max') ? '0' : key.endsWith('template_tier') ? 'standard' : key.includes('level') ? 'none' : 'false')]));
  return Object.fromEntries(pairs);
}

export async function validateStorefrontDocument(pool, businessId, document, {
  previous = null, publish = false, checkCollectionsAndCategories = true,
} = {}) {
  const result = documentErrors(document);
  const errors = result.errors;
  if (!errors.length) {
    const references = [
      ['media', [...result.refs.media], `SELECT "Id" FROM "MediaAssets" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[]) AND "Purpose" IN ('SiteImage','DesignImage')`],
      ...(checkCollectionsAndCategories ? [
        ['collection', [...result.refs.collections], `SELECT "Id" FROM "DesignCollections" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`],
        ['category', [...result.refs.categories], `SELECT "Id" FROM "DesignCategories" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`],
      ] : []),
    ];
    for (const [key, values, sql] of references) {
      if (!values.length) continue;
      const { rows } = await pool.query(sql, [businessId, values]);
      const found = new Set(rows.map((row) => row.Id));
      for (const id of values) if (!found.has(id)) errors.push({ path: key, message: `Referenced ${key} ${id} was not found in your library.` });
    }
  }
  if (errors.length) {
    const list = errors.slice(0, 50);
    throw new AppError(400, 'invalid_document', `The site has ${list.length} problem(s). First: ${list[0].path}: ${list[0].message}`, { errors: list });
  }
  const entitlements = await getEntitlements(pool, businessId);
  const issues = planViolations(document, entitlements, result.template);
  if (publish && issues.length) throw new AppError(403, 'plan_violations', `${issues[0].message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ''} Upgrade your plan or remove it.`, { issues });
  if (!publish && previous) {
    const old = new Set(planViolations(previous, entitlements, templates[previous.templateKey]).map((issue) => issue.code));
    const novel = issues.filter((issue) => !old.has(issue.code));
    if (novel.length) throw new AppError(403, 'plan_violations', `${novel[0].message}${novel.length > 1 ? ` (and ${novel.length - 1} more)` : ''} Upgrade your plan or remove it.`, { issues: novel });
  }
  return { planIssues: issues, mediaIds: [...result.refs.media] };
}

export function validatePresetSection(section) {
  const errors = [];
  const refs = { media: new Set(), collections: new Set(), categories: new Set() };
  const definition = sectionTypes[section.type];
  if (!definition) errors.push({ path: 'section.type', message: `Unknown section type '${section.type}'.` });
  else {
    if (!definition.variants.includes(section.variant)) errors.push({ path: 'section.variant', message: 'Unknown layout.' });
    checkObject('section.props', section.props, definition.props, errors, refs, new Set());
  }
  const style = section.style ?? {};
  for (const key of ['background', 'textColor']) if (style[key] != null && !hexPattern.test(style[key])) errors.push({ path: `section.style.${key}`, message: 'Colours must look like #1A2B3C.' });
  if (style.align != null && !['left', 'center', 'right'].includes(style.align)) errors.push({ path: 'section.style.align', message: 'Unknown alignment.' });
  if (style.spacing != null && !['compact', 'comfortable', 'spacious'].includes(style.spacing)) errors.push({ path: 'section.style.spacing', message: 'Unknown spacing.' });
  if (style.buttonShape != null && !['square', 'rounded', 'pill'].includes(style.buttonShape)) errors.push({ path: 'section.style.buttonShape', message: 'Unknown button shape.' });
  if (refs.media.size) errors.push({ path: 'props', message: 'Presets cannot contain images. Add images after placing the section.' });
  if (errors.length) {
    const first = errors[0];
    throw new AppError(400, 'invalid_document', `The section has ${errors.length} problem(s). First: ${first.path}: ${first.message}`, { errors: errors.slice(0, 50) });
  }
}

export function missingWorkflowEntryPoints(doc, workflows) {
  const entryPoints = { inquiry: ['inquiryForm'], booking: ['booking'], customOrder: ['customOrderForm'], contact: ['contactInfo', 'inquiryForm'] };
  const present = new Set(doc.pages.filter((page) => page.visible).flatMap((page) => page.sections.filter((section) => section.visible).map((section) => section.type)));
  return workflows.filter((workflow) => entryPoints[workflow] && !entryPoints[workflow].some((type) => present.has(type)));
}

export function parseStorefrontDocument(value) {
  try {
    const doc = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Document must be an object.');
    const allowed = ['schemaVersion', 'templateKey', 'theme', 'branding', 'navigation', 'pages', 'archive'];
    const unknown = Object.keys(doc).find((key) => !allowed.includes(key));
    if (unknown) throw new Error(`Unknown property '${unknown}'.`);
    return doc;
  } catch (error) {
    throw AppError.badRequest('invalid_document', `The document could not be read: ${error.message}`);
  }
}