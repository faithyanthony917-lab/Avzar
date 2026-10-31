import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PreviewFrameView, SamplePreviewNote, StorefrontPreviewFrame, TemplateSamplePreview } from '@/components/app/StorefrontPreviewFrame';

const noop = () => undefined;
const view = (over: Partial<Parameters<typeof PreviewFrameView>[0]> = {}) => renderToStaticMarkup(
  <PreviewFrameView path="/preview/tok" device="phone" loading={false} error="" unsaved={false} expiresAtUtc={null} onDevice={noop} onReload={noop} {...over} />);

describe('storefront preview frame', () => {
  it('starts closed with a button and loads nothing', () => {
    const html = renderToStaticMarkup(<StorefrontPreviewFrame storefrontId="s1" revision={3} unsaved={false} />);
    expect(html).toContain('Live preview');
    expect(html).toContain('Show preview');
    expect(html).not.toContain('<iframe');
  });
  it('shows the private preview in a sandboxed frame at phone width, with both width buttons', () => {
    const html = view();
    expect(html).toContain('<iframe');
    expect(html).toContain('src="/preview/tok"');
    expect(html).toContain('sandbox="allow-scripts allow-same-origin"');
    expect(html).not.toContain('allow-forms');
    expect(html).toContain('ap-preview-phone');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Phone/);
    expect(html).toMatch(/aria-pressed="false"[^>]*>Desktop/);
  });
  it('switches the stage class for desktop width', () => {
    const html = view({ device: 'desktop' });
    expect(html).toContain('ap-preview-desktop');
    expect(html).not.toContain('ap-preview-phone');
  });
  it('says the preview shows the last saved draft when there are unsaved changes', () => {
    expect(view({ unsaved: true })).toContain('not saved yet');
    expect(view({ unsaved: false })).not.toContain('not saved yet');
  });
  it('shows loading and error states without a frame, and disables reload while loading', () => {
    const loading = view({ path: null, loading: true });
    expect(loading).not.toContain('<iframe');
    expect(loading).toContain('Preparing the private preview');
    expect(/<button[^>]*disabled[^>]*>Loading/.test(loading)).toBe(true);
    const failed = view({ path: null, error: 'Could not create a preview link.' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Could not create a preview link.');
    expect(failed).not.toContain('<iframe');
  });
  it('adds no inline script or style element', () => {
    expect(/<script|<style/.test(view())).toBe(false);
  });
});

describe('sample of a locked template', () => {
  it('says it is a sample, names the plan and links to the billing page for it', () => {
    const html = renderToStaticMarkup(<SamplePreviewNote templateName="Luxury" tier="advanced" />);
    expect(html).toContain('sample of Luxury');
    expect(html).toContain('not your saved content');
    expect(html).toContain('included from the Professional plan');
    expect(html).toContain('href="/settings/billing?plan=professional"');
  });
  it('for a template the plan includes, says so and shows no upgrade link', () => {
    const html = renderToStaticMarkup(<SamplePreviewNote templateName="Bespoke" tier="basic" allowed />);
    expect(html).toContain('Your plan includes Bespoke');
    expect(html).not.toContain('Upgrade to');
  });
  it('starts by preparing the preview, offers to close, and adds no inline script or style', () => {
    const html = renderToStaticMarkup(<TemplateSamplePreview storefrontId="s1" templateKey="luxury" templateName="Luxury" tier="advanced" onClose={noop} />);
    expect(html).toContain('Sample: Luxury');
    expect(html).toContain('Close sample');
    expect(html).not.toContain('<iframe');
    expect(/<script|<style/.test(html)).toBe(false);
  });
});
