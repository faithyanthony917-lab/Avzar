import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GuidedContent, TemplateGallery, ThemeControls, type GuidedPage, type GuidedSectionType } from '@/components/app/StorefrontGuidedEditor';

const has = (html: string, pattern: RegExp) => pattern.test(html);
const tag = (html: string, pattern: RegExp) => html.match(pattern)?.[0] ?? '';
const spec = (name: string, kind: string, extra: Record<string, unknown> = {}) => ({ name, kind, max: 0, min: 0, required: false, multiline: false, itemMax: 0, fields: null, ...extra });

const types: GuidedSectionType[] = [
  { type: 'hero', label: 'Opening banner', props: [spec('headline', 'Text', { max: 120, required: true }), spec('imageMediaId', 'Guid'), spec('buttonTarget', 'Link')] },
  { type: 'designList', label: 'Designs', props: [spec('limit', 'Int', { min: 1, max: 48 }), spec('showPrices', 'Bool')] },
];
const pages: GuidedPage[] = [{
  id: 'p1', kind: 'home', title: 'Home', visible: true, sections: [
    { id: 's1', type: 'hero', variant: 'centered', visible: true, props: { headline: 'Atelier', buttonTarget: 'action:inquiry' } },
    { id: 's2', type: 'designList', variant: 'grid', visible: true, props: { limit: 8, showPrices: true } },
  ],
}];
const preset = { key: 'clean-professional', name: 'Clean professional', colors: { primary: '#111111', accent: '#222222', text: '#FFFFFF', background: '#FFFFFF' }, headingFont: 'Lato', bodyFont: 'Lato' };
const noop = () => undefined;

describe('template gallery', () => {
  const templates = [
    { key: 'standard', name: 'Standard', description: 'Plain.', tier: 'standard', allowed: true },
    { key: 'bespoke', name: 'Bespoke', description: 'Tailor.', tier: 'basic', allowed: true },
    { key: 'luxury', name: 'Luxury', description: 'Image first.', tier: 'advanced', allowed: false },
  ];
  it('shows the current template, open templates and the reason a template is locked, before any click', () => {
    const html = renderToStaticMarkup(<TemplateGallery templates={templates} currentKey="standard" selectedKey="" capabilities={{ templateTier: 'basic' }} disabled={false} onSelect={noop} />);
    expect(html).toContain('In use on this draft');
    expect(html).toContain('From the Professional plan (yours: Starter).');
    expect(html).toContain('Locked');
    expect(html).toContain('Use this template');
    expect(has(html, / style=|<script|<style/)).toBe(false);
  });
});

describe('guided content', () => {
  it('keeps content fields editable and explains the structure lock on plans without the builder', () => {
    const html = renderToStaticMarkup(<GuidedContent pages={pages} sectionTypes={types} structureLock="Structure needs a plan with the visual builder." disabled={false} media={[{ id: 'm1', fileName: 'logo.png' }]} onChangePages={noop} />);
    expect(html).toContain('Structure needs a plan with the visual builder.');
    expect(html).toContain('Headline (required)');
    expect(html).toContain('logo.png');
    expect(html).toContain('Enquiry form');
    expect(has(tag(html, /<input id="[^"]*headline"[^>]*>/), /disabled/)).toBe(false);
    expect(has(tag(html, /<input type="checkbox"[^>]*>/), /disabled/)).toBe(false);
  });
  it('lets a plan without the builder hide an ordinary section but not the enquiry form or the last visible one', () => {
    const withForm: GuidedPage[] = [{ ...pages[0]!, sections: [...pages[0]!.sections, { id: 's3', type: 'inquiryForm', variant: 'split', visible: true, props: {} }] }];
    const html = renderToStaticMarkup(<GuidedContent pages={withForm} sectionTypes={types} structureLock="Structure needs a plan with the visual builder." disabled={false} media={[]} onChangePages={noop} />);
    // The designList section also has a yes/no field (showPrices), so pick out only the "Show this section" checkboxes.
    const boxes = html.match(/<input type="checkbox"[^>]*>(?=\s*Show this section on the site)/g) ?? [];
    expect(boxes).toHaveLength(3);
    expect(has(boxes[0]!, /disabled/)).toBe(false);
    expect(has(boxes[1]!, /disabled/)).toBe(false);
    expect(has(boxes[2]!, /disabled/)).toBe(true);
    expect(html).toContain('Customers use this section to reach you');
    const single: GuidedPage[] = [{ ...pages[0]!, sections: [pages[0]!.sections[0]!] }];
    const lone = renderToStaticMarkup(<GuidedContent pages={single} sectionTypes={types} structureLock="Structure needs a plan with the visual builder." disabled={false} media={[]} onChangePages={noop} />);
    expect(has(tag(lone, /<input type="checkbox"[^>]*>/), /disabled/)).toBe(true);
    expect(lone).toContain('at least one visible section');
  });
  it('unlocks visibility and ordering on plans with the builder', () => {
    const html = renderToStaticMarkup(<GuidedContent pages={pages} sectionTypes={types} structureLock={null} disabled={false} media={[]} onChangePages={noop} />);
    expect(has(tag(html, /<input type="checkbox"[^>]*>/), /disabled/)).toBe(false);
    expect(html.includes('visual builder')).toBe(false);
  });
  it('shows a field problem next to the field', () => {
    const long = [{ ...pages[0]!, sections: [{ ...pages[0]!.sections[0]!, props: { headline: 'x'.repeat(130) } }] }];
    const html = renderToStaticMarkup(<GuidedContent pages={long} sectionTypes={types} structureLock={null} disabled={false} media={[]} onChangePages={noop} />);
    expect(html).toContain('at most 120');
  });
});

describe('colour and font controls', () => {
  it('limits colours and fonts to what the plan level allows and warns about contrast', () => {
    const basic = renderToStaticMarkup(<ThemeControls theme={{ preset: 'clean-professional' }} presets={[preset]} fonts={['Lato', 'Inter']} capabilities={{ themeLevel: 'basic' }} disabled={false} onChange={noop} />);
    expect(basic).toContain('main colour and the accent');
    expect(basic).toContain('Choosing fonts is not included');
    expect(basic).toContain('Contrast warnings');
    expect(has(tag(basic, /<input id="guided-color-primary"[^>]*>/), /disabled/)).toBe(false);
    expect(has(tag(basic, /<input id="guided-color-heading"[^>]*>/), /disabled/)).toBe(true);
    const none = renderToStaticMarkup(<ThemeControls theme={{}} presets={[preset]} fonts={[]} capabilities={{ themeLevel: 'none' }} disabled={false} onChange={noop} />);
    expect(none).toContain('Changing colours is not included');
    expect(has(tag(none, /<select id="guided-preset"[^>]*>/), /disabled/)).toBe(true);
    const advanced = renderToStaticMarkup(<ThemeControls theme={{}} presets={[preset]} fonts={['Lato']} capabilities={{ themeLevel: 'advanced' }} disabled={false} onChange={noop} />);
    expect(has(tag(advanced, /<select id="guided-headingFont"[^>]*>/), /disabled/)).toBe(false);
  });
});

describe('fixes after the first look on a phone', () => {
  it('selects a colour theme even when the stored theme key is empty or unknown', () => {
    for (const stored of [{}, { preset: '' }, { preset: 'no-such-theme' }]) {
      const html = renderToStaticMarkup(<ThemeControls theme={stored} presets={[preset]} fonts={[]} capabilities={{ themeLevel: 'none' }} disabled={false} onChange={noop} />);
      expect(tag(html, /<option[^>]*value="clean-professional"[^>]*>/)).toContain('selected');
    }
  });

  it('labels a category field as a category and does not offer image files for it', () => {
    const withCategory: GuidedSectionType[] = [{ type: 'designList', label: 'Designs', props: [spec('categoryId', 'Guid')] }];
    const list: GuidedPage[] = [{ id: 'p1', kind: 'home', title: 'Home', visible: true, sections: [{ id: 's1', type: 'designList', variant: 'grid', visible: true, props: { categoryId: null } }] }];
    const html = renderToStaticMarkup(<GuidedContent pages={list} sectionTypes={withCategory} structureLock={null} disabled={false} media={[{ id: 'm1', fileName: 'logo.png' }]} onChangePages={noop} />);
    expect(html).toContain('Category');
    expect(html).toContain('All categories');
    expect(html).not.toContain('logo.png');
    expect(html).not.toContain('Choose from your uploaded images');
  });
});

describe('samples of locked templates', () => {
  const templates = [
    { key: 'standard', name: 'Standard', description: 'Plain.', tier: 'standard', allowed: true, sample: false },
    { key: 'bespoke', name: 'Bespoke', description: 'Tailor.', tier: 'basic', allowed: false, sample: true },
    { key: 'luxury', name: 'Luxury', description: 'Image first.', tier: 'advanced', allowed: false, sample: true },
    { key: 'streetwear', name: 'Streetwear', description: 'Loud.', tier: 'premium', allowed: false, sample: true },
  ];
  it('offers a sample and an upgrade link on every locked template with a sample', () => {
    const html = renderToStaticMarkup(<TemplateGallery templates={templates} currentKey="standard" selectedKey="" capabilities={{ templateTier: 'standard' }} disabled={false} onSelect={noop} onSample={noop} />);
    expect(html).toContain('From the Starter plan (yours: Free).');
    expect(html).not.toContain('Your plan includes templates up to');
    expect(html).toContain('See a sample of the Bespoke template');
    expect(html).toContain('See a sample of the Luxury template');
    expect(html).toContain('See a sample of the Streetwear template');
    expect(html).not.toContain('See a sample of the Standard template');
    expect(html).toContain('href="/settings/billing?plan=starter"');
    expect(html).toContain('href="/settings/billing?plan=professional"');
    expect(html).toContain('Upgrade to Business');
    expect(has(html, / style=|<script|<style/)).toBe(false);
  });
  it('offers a sample but no upgrade control on a template the plan already includes', () => {
    const open = templates.map((t) => ({ ...t, allowed: true }));
    const html = renderToStaticMarkup(<TemplateGallery templates={open} currentKey="standard" selectedKey="" capabilities={{ templateTier: 'premium' }} disabled={false} onSelect={noop} onSample={noop} />);
    expect(html).toContain('See a sample of the Bespoke template');
    expect(html).toContain('See a sample of the Luxury template');
    expect(html).not.toContain('See a sample of the Standard template');
    expect(html).not.toContain('Upgrade to');
  });
});
