import { randomUUID } from 'node:crypto';
import { storefrontDocumentCatalog } from './storefrontDocument.js';

/**
 * Starter documents: what a brand-new storefront contains for each template.
 *
 * The starters differ in structure (which sections, in which order, in which layout), not just in colour. Each one
 * uses only section types and layouts its template supports and only what the template's own plan tier allows, so
 * a new site never starts out in violation of the plan that unlocked its template. Text is placeholder wording the
 * owner replaces; nothing here invents customer quotes, prices or photos.
 */

const page = (kind, slug, title, sections) => ({
  id: randomUUID(), kind, slug, title, visible: true,
  seo: { title: null, description: null, shareImageMediaId: null }, sections,
});

const section = (type, variant, props, align = 'left') => ({
  id: randomUUID(), type, variant, visible: true, props,
  style: { background: null, backgroundMediaId: null, align, spacing: 'comfortable', textColor: null, buttonShape: null },
});

const intro = 'Tell us what you have in mind and we will reply personally.';

const starters = {
  // Today's layout, unchanged: a centred hero, a grid of designs, a short enquiry form.
  standard: (name) => ({
    preset: 'clean-professional',
    home: [
      section('hero', 'centered', { headline: name, subheadline: 'Made-to-measure clothing, made with care.', buttonLabel: 'Browse designs', buttonTarget: 'action:inquiry' }, 'center'),
      section('designList', 'grid', { heading: 'Featured designs', featuredOnly: true, limit: 8, showPrices: true }),
      section('inquiryForm', 'minimal', { heading: 'Ask about a design', intro }),
    ],
    catalog: [section('designList', 'grid', { heading: 'Our designs', limit: 48, showPrices: true })],
    about: [section('about', 'simple', { heading: `About ${name}`, body: 'Tell your customers who you are and how you work.' })],
    contact: [
      section('contactInfo', 'simple', { heading: 'Visit or contact us', showAddress: true, showPhone: true, showEmail: true, showHours: true }),
      section('inquiryForm', 'minimal', { heading: 'Send us a message', intro }),
    ],
    design: [section('inquiryForm', 'minimal', { heading: 'Interested in this design?', intro })],
  }),

  // Story first: who makes the clothes and how the work goes, then a numbered, left-aligned run of sections.
  bespoke: (name) => ({
    preset: 'elegant',
    home: [
      section('hero', 'split-right', { headline: name, subheadline: 'Clothing cut and sewn to your measurements.', buttonLabel: 'Start an enquiry', buttonTarget: 'action:inquiry' }),
      section('about', 'split', { heading: 'The tailor behind the work', body: 'Tell your customers who you are, how long you have been sewing and what you are known for.' }),
      section('richText', 'narrow', { heading: 'How an order works', body: 'Explain your steps in a few lines: the first conversation, taking measurements, fittings and delivery.' }),
      section('designList', 'editorial', { heading: 'Recent work', featuredOnly: true, limit: 6, showPrices: false }),
      section('inquiryForm', 'split', { heading: 'Start a conversation', intro }),
    ],
    catalog: [section('designList', 'editorial', { heading: 'Our work', limit: 48, showPrices: false })],
    about: [
      section('about', 'split', { heading: `About ${name}`, body: 'Tell your customers who you are and how you work.' }),
      section('richText', 'narrow', { heading: 'Our process', body: 'Describe how an order goes from the first message to the final fitting.' }),
    ],
    contact: [
      section('contactInfo', 'split', { heading: 'Visit or contact us', showAddress: true, showPhone: true, showEmail: true, showHours: true }),
      section('inquiryForm', 'split', { heading: 'Send us a message', intro }),
    ],
    design: [section('inquiryForm', 'minimal', { heading: 'Interested in this design?', intro })],
  }),

  // Image first: a full-height opening, one spotlighted design, the designer, then a quiet closing enquiry.
  luxury: (name) => ({
    preset: 'modern-luxury',
    home: [
      section('hero', 'fullbleed', { headline: name, subheadline: 'Considered pieces, made to order.', buttonLabel: 'Enquire', buttonTarget: 'action:inquiry' }, 'center'),
      section('featuredDesigns', 'spotlight', { heading: 'The collection', limit: 3, showPrices: false }, 'center'),
      section('designerProfile', 'large', { name, role: 'Founder and designer', bio: 'Tell your story: what drives your work, how you choose fabrics and who you design for.' }),
      section('designList', 'editorial', { heading: 'From the studio', limit: 6, showPrices: false }, 'center'),
      section('inquiryForm', 'minimal', { heading: 'Private enquiries', intro }, 'center'),
    ],
    catalog: [section('designList', 'editorial', { heading: 'The collection', limit: 48, showPrices: false }, 'center')],
    about: [section('about', 'split', { heading: `About ${name}`, body: 'Tell your customers who you are and how you work.' })],
    contact: [
      section('contactInfo', 'split', { heading: 'Visit or contact us', showAddress: true, showPhone: true, showEmail: true, showHours: true }),
      section('inquiryForm', 'minimal', { heading: 'Send us a message', intro }),
    ],
    design: [section('inquiryForm', 'minimal', { heading: 'Interested in this design?', intro })],
  }),
  // Shop-style: a full-width banner, then a dense grid of products. Only basic-level sections, so Starter can use it.
  'ready-to-wear': (name) => ({
    home: [
      section('hero', 'fullbleed', { headline: name, subheadline: 'Ready to wear, ready to ship.', buttonLabel: 'Shop the range', buttonTarget: 'page:catalog' }, 'center'),
      section('designList', 'dense-grid', { heading: 'New arrivals', limit: 12, showPrices: true }),
      section('richText', 'simple', { heading: 'Sizing and delivery', body: 'Explain your sizes, delivery areas and how returns work.' }),
      section('inquiryForm', 'minimal', { heading: 'Questions about an item', intro }),
    ],
    catalog: [section('designList', 'dense-grid', { heading: 'Shop all', limit: 48, showPrices: true })],
    about: [section('about', 'simple', { heading: `About ${name}`, body: 'Tell your customers who you are and how you work.' })],
    contact: [
      section('contactInfo', 'simple', { heading: 'Visit or contact us', showAddress: true, showPhone: true, showEmail: true, showHours: true }),
      section('inquiryForm', 'minimal', { heading: 'Send us a message', intro }),
    ],
    design: [section('inquiryForm', 'minimal', { heading: 'Interested in this item?', intro })],
  }),

  // Heritage and story: a split opening, the designer, patterned editorial work, then a commission form.
  'african-heritage': (name) => ({
    home: [
      section('hero', 'split-left', { headline: name, subheadline: 'Heritage cloth, cut for you.', buttonLabel: 'Commission a piece', buttonTarget: 'action:custom-order' }),
      section('designerProfile', 'centered', { name, role: 'Designer', bio: 'Tell the story behind your work: the cloth you choose, where it comes from and who wears it.' }, 'center'),
      section('featuredDesigns', 'row', { heading: 'Pieces to inspire you', limit: 6, showPrices: false }),
      section('customOrderForm', 'split', { heading: 'Commission a piece', intro }),
    ],
    catalog: [section('designList', 'editorial', { heading: 'The collection', limit: 48, showPrices: false })],
    about: [section('about', 'split', { heading: `About ${name}`, body: 'Tell your customers who you are and how you work.' })],
    contact: [
      section('contactInfo', 'split', { heading: 'Visit or contact us', showAddress: true, showPhone: true, showEmail: true, showHours: true }),
      section('inquiryForm', 'split', { heading: 'Send us a message', intro }),
    ],
    design: [section('inquiryForm', 'minimal', { heading: 'Interested in this design?', intro })],
  }),

  // Consultation first: a gentle opening, the journey in a few lines, one spotlighted gown, then a booking form.
  bridal: (name) => ({
    home: [
      section('hero', 'centered', { headline: name, subheadline: 'Gowns and occasion wear, designed around you.', buttonLabel: 'Book a consultation', buttonTarget: 'action:booking' }, 'center'),
      section('richText', 'narrow', { heading: 'Your bridal journey', body: 'Describe the steps: the first consultation, choosing the design, fittings and the final collection.' }, 'center'),
      section('featuredDesigns', 'spotlight', { heading: 'Featured gowns', limit: 3, showPrices: false }, 'center'),
      section('booking', 'split', { heading: 'Book a consultation', intro: 'Choose a time to visit and tell us about your occasion.' }),
    ],
    catalog: [section('designList', 'editorial', { heading: 'Gowns and occasion wear', limit: 48, showPrices: false }, 'center')],
    about: [section('about', 'split', { heading: `About ${name}`, body: 'Tell your customers who you are and how you work.' })],
    contact: [
      section('contactInfo', 'split', { heading: 'Visit or contact us', showAddress: true, showPhone: true, showEmail: true, showHours: true }),
      section('inquiryForm', 'split', { heading: 'Send us a message', intro }),
    ],
    design: [section('inquiryForm', 'split', { heading: 'Interested in this design?', intro })],
  }),

  // Product first and loud: a minimal opening, a dense latest-drop grid, a row of picks, a short form.
  streetwear: (name) => ({
    home: [
      section('hero', 'minimal', { headline: name, subheadline: 'New drops. Limited runs.', buttonLabel: 'See the drop', buttonTarget: 'page:catalog' }),
      section('designList', 'dense-grid', { heading: 'Latest drop', limit: 12, showPrices: true }),
      section('featuredDesigns', 'row', { heading: 'Staff picks', limit: 6, showPrices: true }),
      section('inquiryForm', 'minimal', { heading: 'Custom or bulk orders', intro }),
    ],
    catalog: [section('designList', 'dense-grid', { heading: 'All pieces', limit: 48, showPrices: true })],
    about: [section('about', 'simple', { heading: `About ${name}`, body: 'Tell your customers who you are and how you work.' })],
    contact: [
      section('contactInfo', 'simple', { heading: 'Visit or contact us', showAddress: true, showPhone: true, showEmail: true, showHours: true }),
      section('inquiryForm', 'minimal', { heading: 'Send us a message', intro }),
    ],
    design: [section('inquiryForm', 'minimal', { heading: 'Interested in this piece?', intro })],
  }),

  // The maker and the craft: a split opening, the designer's profile, the process, a list of pieces, then a studio visit.
  'atelier-studio': (name) => ({
    home: [
      section('hero', 'split-left', { headline: name, subheadline: 'A working studio. Every piece made by hand.', buttonLabel: 'Book a studio visit', buttonTarget: 'action:booking' }),
      section('designerProfile', 'large', { name, role: 'Founder and maker', bio: 'Tell your story: your training, your process and what makes your studio different.' }),
      section('richText', 'narrow', { heading: 'How we work', body: 'Describe your process from sketch to finished piece, and how long each step takes.' }),
      section('designList', 'list', { heading: 'Pieces and prices', limit: 8, showPrices: true }),
      section('booking', 'split', { heading: 'Book a studio visit', intro: 'Pick a time and tell us what you would like made.' }),
    ],
    catalog: [section('designList', 'list', { heading: 'Pieces and prices', limit: 48, showPrices: true })],
    about: [section('about', 'split', { heading: `About ${name}`, body: 'Tell your customers who you are and how you work.' })],
    contact: [
      section('contactInfo', 'split', { heading: 'Visit or contact us', showAddress: true, showPhone: true, showEmail: true, showHours: true }),
      section('inquiryForm', 'split', { heading: 'Send us a message', intro }),
    ],
    design: [section('inquiryForm', 'split', { heading: 'Interested in this piece?', intro })],
  }),
};

export const starterTemplateKeys = Object.freeze(Object.keys(starters));

/** Templates an owner may see as a sample before the plan includes them: every template with a look of its own. Standard is in every plan, so it needs no sample. */
export const sampleTemplateKeys = Object.freeze(starterTemplateKeys.filter((key) => key !== 'standard'));

/** True for templates that have a layout of their own; the others begin from the standard layout, fitted to what they allow. */
export function hasStarter(templateKey) {
  return Object.hasOwn(starters, templateKey);
}

// A template without its own starter yet: keep the standard content, but only the sections the template supports,
// each in the first layout it allows, so the first save of the new draft cannot fail validation.
function fitToTemplate(sections, definition) {
  return sections.flatMap((item) => {
    const supported = definition[item.type];
    if (!supported) return [];
    return [supported.includes(item.variant) ? item : { ...item, variant: supported[0] }];
  });
}

/**
 * A complete schema-v1 document for a new site. `templateKey` must be a real template.
 * Throws for an unknown key so a typo can never create a document of the wrong template.
 */
export function starterDocument(name, templateKey = 'standard') {
  const definition = storefrontDocumentCatalog.templates[templateKey];
  if (!definition) throw new Error(`Unknown storefront template '${templateKey}'.`);
  const own = hasStarter(templateKey);
  const content = (own ? starters[templateKey] : starters.standard)(name);
  const shape = (sections) => (own ? sections : fitToTemplate(sections, definition));
  const pages = [
    page('home', '', 'Home', shape(content.home)),
    page('catalog', 'designs', 'Designs', shape(content.catalog)),
    page('design', 'design', 'Design', shape(content.design)),
    page('about', 'about', 'About', shape(content.about)),
    page('contact', 'contact', 'Contact', shape(content.contact)),
  ];
  // A starter may point a button at a page by its kind ('page:catalog'); the page ids are only known here.
  const pageIdByKind = new Map(pages.map((item) => [item.kind, item.id]));
  for (const item of pages.flatMap((entry) => entry.sections)) {
    const target = item.props.buttonTarget;
    if (typeof target === 'string' && target.startsWith('page:')) item.props.buttonTarget = pageIdByKind.get(target.slice(5)) ?? 'action:inquiry';
  }
  return {
    schemaVersion: 1, templateKey,
    theme: { preset: (own && content.preset) || definition.preset, colors: {}, headingFont: null, bodyFont: null, headingStyle: null, buttonShape: null, radius: null, sectionSpacing: null },
    branding: { logoMediaId: null, logoWidth: 120, logoPlacement: 'left', faviconMediaId: null, shareImageMediaId: null, tagline: null, footerText: null, socialLinks: [] },
    navigation: pages.filter((item) => item.kind !== 'design').map((item) => ({ label: item.kind === 'home' ? 'Home' : item.title, pageId: item.id, visible: true })),
    pages, archive: [],
  };
}
