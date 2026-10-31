import type { Page, Site } from './types';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pagePath(base: string, page: Page): string {
  return page.slug === '' ? `${base || '/'}` : `${base}/${page.slug}`;
}

const ACTION_SECTIONS: Record<string, string[]> = {
  'action:inquiry': ['inquiryForm'],
  'action:booking': ['booking'],
  'action:custom-order': ['customOrderForm'],
  'action:contact': ['contactInfo', 'inquiryForm'],
};

/**
 * Turns a link value from the saved document into a safe href. Only three shapes exist (the API validated them):
 * a page id, a form action, or an https address. Anything else becomes "#" so a bad value can never become a script link.
 */
export function resolveLink(site: Site, base: string, target: unknown): { href: string; external: boolean } {
  if (typeof target !== 'string') return { href: '#', external: false };
  if (GUID.test(target)) {
    const page = site.document.pages.find((p) => p.id === target);
    return { href: page ? pagePath(base, page) : '#', external: false };
  }
  const types = ACTION_SECTIONS[target];
  if (types) {
    for (const page of site.document.pages) {
      const section = page.sections.find((s) => types.includes(s.type));
      if (section) return { href: `${pagePath(base, page)}#sec-${section.id}`, external: false };
    }
    return { href: '#', external: false };
  }
  try {
    const url = new URL(target);
    if (url.protocol === 'https:') return { href: url.toString(), external: true };
  } catch { /* fall through */ }
  return { href: '#', external: false };
}
