import { describe, expect, it } from 'vitest';
import { resolveLink } from '../src/lib/links';
import { themeStyle, fontsHref } from '../src/lib/theme';
import { money, paragraphs } from '../src/lib/format';
import type { Site, Theme } from '../src/lib/types';

const pageId = '11111111-1111-4111-8111-111111111111';
const sectionId = '22222222-2222-4222-8222-222222222222';
const site = {
  document: {
    pages: [
      { id: pageId, kind: 'about', slug: 'about', title: 'About', visible: true, seo: {}, sections: [] },
      { id: 'c', kind: 'contact', slug: 'contact', title: 'Contact', visible: true, seo: {}, sections: [{ id: sectionId, type: 'inquiryForm', variant: 'minimal', visible: true, props: {}, style: { align: 'left', spacing: 'comfortable' } }] },
    ],
  },
} as unknown as Site;

describe('resolveLink: only pages, forms and https can become hrefs', () => {
  it('maps a page id to its path', () => expect(resolveLink(site, '', pageId)).toEqual({ href: '/about', external: false }));
  it('keeps the site base path', () => expect(resolveLink(site, '/sites/x', pageId).href).toBe('/sites/x/about'));
  it('maps a form action to the section that hosts it', () => expect(resolveLink(site, '', 'action:inquiry').href).toBe(`/contact#sec-${sectionId}`));
  it('accepts https and marks it external', () => expect(resolveLink(site, '', 'https://example.com/a')).toEqual({ href: 'https://example.com/a', external: true }));
  it.each(['javascript:alert(1)', 'data:text/html,x', 'http://example.com', '//evil.com', 'vbscript:x', '', 'action:unknown'])('neutralises %s', (bad) => {
    expect(resolveLink(site, '', bad).href).toBe('#');
  });
  it('neutralises non-strings', () => expect(resolveLink(site, '', { href: 'x' }).href).toBe('#'));
  it('a missing page is a dead link, not a crash', () => expect(resolveLink(site, '', '99999999-9999-4999-8999-999999999999').href).toBe('#'));
});

describe('themeStyle: re-validates what the API already validated', () => {
  const theme: Theme = {
    colors: { primary: '#aabbcc', background: 'red; background:url(x)', 'bad key': '#000000', text: '#112233' },
    headingFont: "Playfair Display", bodyFont: "x'; } body { display:none; /*", headingStyle: 'uppercase', buttonShape: 'pill', radius: 999, sectionSpacing: 'spacious',
  };
  const style = themeStyle(theme) as Record<string, string>;
  it('keeps valid colours only', () => {
    expect(style['--c-primary']).toBe('#aabbcc');
    expect(style['--c-text']).toBe('#112233');
    expect(style['--c-background']).toBeUndefined();
    expect(Object.keys(style).some((k) => k.includes(' '))).toBe(false);
  });
  it('rejects a font name that could break out of the rule', () => expect(style['--font-body']).toBe('system-ui, sans-serif'));
  it('keeps a normal font', () => expect(style['--font-heading']).toBe("'Playfair Display', serif"));
  it('clamps the radius', () => expect(style['--radius']).toBe('32px'));
  it('maps shapes and spacing', () => { expect(style['--btn-radius']).toBe('999px'); expect(style['--space']).toBe('6rem'); expect(style['--heading-transform']).toBe('uppercase'); });
  it('builds a fonts URL from safe names only', () => {
    const href = fontsHref(theme)!;
    expect(href).toContain('family=Playfair+Display');
    expect(href).not.toContain('display:none');
  });
});

describe('format helpers', () => {
  it('formats money', () => expect(money(1500, 'NGN')).toContain('1,500'));
  it('returns null without a price', () => expect(money(null, 'NGN')).toBeNull());
  it('shows a plain number, not an invented currency, when none is given', () => {
    expect(money(1500, null)).toBe('1,500');
    expect(money(1500, '')).toBe('1,500');
  });
  it('uses the currency it is given', () => expect(money(1500, 'GBP')).toContain('£'));
  it('splits plain text into paragraphs and ignores non-strings', () => {
    expect(paragraphs('a\n\nb\r\nc')).toEqual(['a', 'b', 'c']);
    expect(paragraphs(42)).toEqual([]);
  });
});
