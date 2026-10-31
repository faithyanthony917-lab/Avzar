import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(path.resolve(__dirname, '../../app/site-templates.css'), 'utf8');
const layout = readFileSync(path.resolve(__dirname, '../../app/layout.tsx'), 'utf8');

/** Every rule's selector list, with comments removed and @media wrappers flattened. */
function selectors(source: string): string[] {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const result: string[] = [];
  const pattern = /([^{}]+)\{[^{}]*\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(bare)) !== null) {
    const head = match[1]!.trim();
    if (head.startsWith('@')) continue;
    result.push(...head.split(',').map((item) => item.trim()).filter(Boolean));
  }
  return result;
}

describe('storefront template styles', () => {
  const list = selectors(css);

  it('is loaded by the root layout', () => {
    expect(layout).toContain("import './site-templates.css';");
  });

  it('scopes every rule to a template so the app screens are untouched', () => {
    expect(list.length).toBeGreaterThan(100);
    for (const selector of list) {
      expect(selector, selector).toMatch(/^(html:has\()?\.site\[data-template="(bespoke|luxury|ready-to-wear|african-heritage|bridal|streetwear|atelier-studio)"\]/);
    }
  });

  it('gives each of the seven other looks its own block and leaves standard as the baseline', () => {
    for (const key of ['bespoke', 'luxury', 'ready-to-wear', 'african-heritage', 'bridal', 'streetwear', 'atelier-studio']) {
      expect(list.filter((selector) => selector.includes(`data-template="${key}"`)).length, key).toBeGreaterThan(5);
    }
    expect(list.some((selector) => selector.includes('data-template="standard"'))).toBe(false);
  });

  it('never sets a colour of its own, so the theme and its contrast checks stay in charge', () => {
    const withoutVarFallbacks = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/var\([^)]*\)/g, 'var()');
    expect(withoutVarFallbacks).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutVarFallbacks).not.toMatch(/\b(rgb|rgba|hsl|hsla)\(/);
  });

  it('keeps motion behind the reduced-motion preference', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion:no-preference\)\{[\s\S]*scroll-behavior:smooth/);
    const outside = css.replace(/@media \(prefers-reduced-motion:no-preference\)\{[\s\S]*?\n\}\n/, '');
    expect(outside).not.toMatch(/transition|scroll-behavior|animation/);
  });

  it('has a small-screen block for every look that needs one', () => {
    const small = css.slice(css.indexOf('@media (max-width:48rem)'));
    for (const key of ['bespoke', 'luxury', 'bridal', 'streetwear', 'atelier-studio']) expect(small, key).toContain(`data-template="${key}"`);
  });
});
