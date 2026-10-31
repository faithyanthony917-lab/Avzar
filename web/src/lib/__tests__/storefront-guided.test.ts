import { describe, expect, it } from 'vitest';
import {
  addItem, brandingAbilities, contrastIssues, effectiveColors, fieldIssue, labelFor, newItem, normalizeHex, removeItem, setItemProp, setProp,
  ALWAYS_VISIBLE_TYPES, PREVIEW_DEVICES, hasUnsavedChanges, hideBlockReason, officialSiteUrl, previewPath,
  structureLockReason, templateStatus, themeAbilities, COLOR_KEYS, planFromQuery, upgradePath, describeAdditions, switchNeedsChoice, switchSuccessMessage, type PropSpec,
} from '../storefront-guided';

const template = (key: string, tier: string, allowed: boolean) => ({ key, name: key, description: '', tier, allowed });
const text = (name: string, max: number, required = false): PropSpec => ({ name, kind: 'Text', max, min: 0, required, multiline: false, itemMax: 0, fields: null });
const list = (name: string, max: number, fields: PropSpec[]): PropSpec => ({ name, kind: 'List', max, min: 0, required: false, multiline: false, itemMax: 0, fields });

describe('template gallery status', () => {
  it('marks the current template and open templates', () => {
    expect(templateStatus(template('standard', 'standard', true), 'standard', { templateTier: 'standard' })).toEqual({ state: 'current' });
    expect(templateStatus(template('bespoke', 'basic', true), 'standard', { templateTier: 'basic' })).toEqual({ state: 'available' });
  });
  it('explains a locked template with the plan that unlocks it, before any click', () => {
    const status = templateStatus(template('luxury', 'advanced', false), 'standard', { templateTier: 'basic' });
    expect(status.state).toBe('locked');
    if (status.state === 'locked') {
      expect(status.reason).toContain('Professional');
      expect(status.reason).toContain('Starter');
    }
  });
  it('names Business for the premium tier', () => {
    const status = templateStatus(template('streetwear', 'premium', false), 'standard', { templateTier: 'standard' });
    expect(status.state === 'locked' && status.reason.includes('Business')).toBe(true);
  });
});

describe('plan locks in the editor', () => {
  it('explains the structure lock only without the builder', () => {
    expect(structureLockReason({ builder: true })).toBeNull();
    expect(structureLockReason({ builder: false })).toContain('still edit all the text');
    expect(structureLockReason({ builder: false })).toContain('hide or show sections');
  });
  it('follows the backend thresholds for theme levels', () => {
    const none = themeAbilities({ themeLevel: 'none' });
    expect(none.choosePreset).toBe(false); expect(none.colorKeys).toEqual([]); expect(none.chooseFonts).toBe(false);
    const basic = themeAbilities({ themeLevel: 'basic' });
    expect(basic.choosePreset).toBe(true); expect(basic.colorKeys).toEqual(['primary', 'accent']); expect(basic.chooseFonts).toBe(false);
    expect(basic.colorReason).toContain('main colour');
    const advanced = themeAbilities({ themeLevel: 'advanced' });
    expect(advanced.colorKeys).toHaveLength(COLOR_KEYS.length); expect(advanced.chooseFonts).toBe(true); expect(advanced.chooseStyle).toBe(false);
    expect(themeAbilities({ themeLevel: 'full' }).chooseStyle).toBe(true);
    expect(themeAbilities({ themeLevel: 'unknown' }).colorKeys).toEqual([]);
  });
});

describe('branding locks', () => {
  it('follows the backend branding levels', () => {
    expect(brandingAbilities({ brandingLevel: 'none' }).logo).toBe(false);
    expect(brandingAbilities({ brandingLevel: 'basic' }).logo).toBe(true);
    expect(brandingAbilities({ brandingLevel: 'basic' }).tagline).toBe(false);
    expect(brandingAbilities({ brandingLevel: 'advanced' }).taglineReason).toContain('tagline');
    expect(brandingAbilities({ brandingLevel: 'full' }).taglineReason).toBeNull();
  });
});

describe('colours', () => {
  it('normalises six-digit hex values and rejects the rest', () => {
    expect(normalizeHex('c9a961')).toBe('#C9A961');
    expect(normalizeHex(' #c9a961 ')).toBe('#C9A961');
    expect(normalizeHex('#fff')).toBeNull();
    expect(normalizeHex('red')).toBeNull();
  });
  it('warns about poor contrast with the same pairs and limits as the server', () => {
    expect(contrastIssues({ text: '#FFFFFF', background: '#FFFFFF' })).toEqual([{ foreground: 'text', background: 'background', ratio: 1, required: 4.5 }]);
    expect(contrastIssues({ text: '#111111', background: '#FFFFFF', heading: '#111111' })).toEqual([]);
    expect(contrastIssues({ text: '#111111' })).toEqual([]);
  });
  it('lays overrides over the preset colours', () => {
    expect(effectiveColors({ primary: '#111111', accent: '#222222' }, { primary: '#333333' })).toEqual({ primary: '#333333', accent: '#222222' });
    expect(effectiveColors({ primary: '#111111' }, undefined)).toEqual({ primary: '#111111' });
  });
});

describe('generated content fields', () => {
  it('checks required, length and scripts like the server', () => {
    expect(fieldIssue(text('headline', 10, true), '')).toBe('This field is required.');
    expect(fieldIssue(text('headline', 10, true), 'x'.repeat(11))).toContain('at most 10');
    expect(fieldIssue(text('headline', 50), '<script>x</script>')).toContain('Scripts');
    expect(fieldIssue(text('headline', 50), 'Fine')).toBeNull();
    expect(fieldIssue({ ...text('limit', 0), kind: 'Int', min: 1, max: 48 }, '60')).toContain('48');
    expect(fieldIssue({ ...text('limit', 0), kind: 'Int', min: 1, max: 48 }, '2.5')).toContain('whole');
  });
  it('sets and clears props without mutating the original', () => {
    const props = { headline: 'A' };
    expect(setProp(props, 'headline', 'B')).toEqual({ headline: 'B' });
    expect(setProp(props, 'headline', '')).toEqual({});
    expect(props).toEqual({ headline: 'A' });
  });
  it('edits, adds and removes list items within the list limit', () => {
    const spec = list('items', 2, [text('title', 60, true), text('description', 300)]);
    expect(newItem(spec)).toEqual({ title: '' });
    let props = addItem({}, spec);
    props = addItem(props, spec);
    expect(addItem(props, spec)).toBe(props);
    props = setItemProp(props, 'items', 1, 'title', 'Alterations');
    expect(props).toEqual({ items: [{ title: '' }, { title: 'Alterations' }] });
    expect(removeItem(props, 'items', 0)).toEqual({ items: [{ title: 'Alterations' }] });
  });
  it('makes readable labels', () => {
    expect(labelFor('buttonLabel')).toBe('Button label');
    expect(labelFor('imageMediaId')).toBe('Image');
    expect(labelFor('showPhone')).toBe('Show phone');
  });
});

describe('hiding sections on plans without the builder', () => {
  const sec = (type: string, visible = true) => ({ type, visible });
  it('lets a section that is not an entry point be hidden while another stays visible', () => {
    expect(hideBlockReason([sec('hero'), sec('designList'), sec('inquiryForm')], 0)).toBeNull();
    expect(hideBlockReason([sec('hero'), sec('designList')], 1)).toBeNull();
  });
  it('never blocks showing a hidden section', () => {
    expect(hideBlockReason([sec('inquiryForm', false), sec('hero')], 0)).toBeNull();
    expect(hideBlockReason([sec('hero', false)], 0)).toBeNull();
  });
  it('keeps every entry-point section visible, matching the backend list', () => {
    expect(ALWAYS_VISIBLE_TYPES).toEqual(['inquiryForm', 'booking', 'customOrderForm', 'contactInfo']);
    for (const type of ALWAYS_VISIBLE_TYPES) expect(hideBlockReason([sec(type), sec('hero')], 0)).toContain('reach you');
  });
  it('keeps one visible section on each page', () => {
    expect(hideBlockReason([sec('about')], 0)).toContain('at least one visible section');
    expect(hideBlockReason([sec('hero'), sec('about', false)], 0)).toContain('at least one visible section');
  });
});

describe('official link and preview helpers', () => {
  it('builds the /sites/<slug> link on the address in use and stays empty until the address is known', () => {
    expect(officialSiteUrl('https://avzar-web.onrender.com', 'taratara')).toBe('https://avzar-web.onrender.com/sites/taratara');
    expect(officialSiteUrl('https://avzar-web.onrender.com/', 'a b')).toBe('https://avzar-web.onrender.com/sites/a%20b');
    expect(officialSiteUrl('', 'taratara')).toBe('');
  });
  it('encodes the preview token in the path and offers phone and desktop widths', () => {
    expect(previewPath('abc.def')).toBe('/preview/abc.def');
    expect(previewPath('a/b')).toBe('/preview/a%2Fb');
    expect(PREVIEW_DEVICES.map((item) => item.key)).toEqual(['phone', 'desktop', 'fit']);
  });
  it('reports unsaved changes only once a saved copy is known and differs', () => {
    const doc = { a: 1 };
    expect(hasUnsavedChanges('', doc)).toBe(false);
    expect(hasUnsavedChanges(JSON.stringify(doc), doc)).toBe(false);
    expect(hasUnsavedChanges(JSON.stringify(doc), { a: 2 })).toBe(true);
  });
});

describe('upgrade link', () => {
  it('points at the plan that includes the template tier, and at nothing for the free tier or an unknown one', () => {
    expect(upgradePath('basic')).toBe('/settings/billing?plan=starter');
    expect(upgradePath('advanced')).toBe('/settings/billing?plan=professional');
    expect(upgradePath('premium')).toBe('/settings/billing?plan=business');
    expect(upgradePath('standard')).toBeNull();
    expect(upgradePath('nonsense')).toBeNull();
  });
  it('accepts only a plain plan code from the address', () => {
    expect(planFromQuery('starter')).toBe('starter');
    expect(planFromQuery(['professional', 'x'])).toBe('professional');
    expect(planFromQuery(undefined)).toBeNull();
    expect(planFromQuery('')).toBeNull();
    expect(planFromQuery('<script>')).toBeNull();
    expect(planFromQuery('a'.repeat(41))).toBeNull();
  });
});

describe('template switch choice', () => {
  const additions = [{ type: 'featuredDesigns', variant: 'spotlight', page: 'Home' }, { type: 'designerProfile', variant: 'large', page: 'Home' }];

  it('asks only when another template brings sections the plan may add', () => {
    expect(switchNeedsChoice({ additions, canAddSections: true }, 'standard', 'luxury')).toBe(true);
    expect(switchNeedsChoice({ additions, canAddSections: false }, 'standard', 'luxury')).toBe(false);
    expect(switchNeedsChoice({ additions: [], canAddSections: true }, 'standard', 'luxury')).toBe(false);
    expect(switchNeedsChoice({ additions, canAddSections: true }, 'luxury', 'luxury')).toBe(false);
  });

  it('describes each added section with its plain name and page', () => {
    const labels: Record<string, string> = { featuredDesigns: 'Featured designs' };
    expect(describeAdditions(additions, (type) => labels[type] ?? type)).toEqual(['Featured designs \u00b7 Home', 'designerProfile \u00b7 Home']);
    expect(describeAdditions([], (type) => type)).toEqual([]);
  });

  it('tells the owner what was added and what was set aside', () => {
    expect(switchSuccessMessage('Luxury', 0, 0)).toBe('Luxury template applied to your draft. Publish when you are happy.');
    expect(switchSuccessMessage('Luxury', 0, 1)).toContain('1 section from the template was added after your own.');
    expect(switchSuccessMessage('Luxury', 2, 3)).toContain('3 sections from the template were added after your own.');
    expect(switchSuccessMessage('Luxury', 2, 3)).toContain('2 section(s) it does not support were set aside');
  });
});
