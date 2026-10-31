import type { CSSProperties } from 'react';
import type { Theme } from './types';

const HEX = /^#[0-9a-f]{6}$/i;
const FONT = /^[A-Za-z0-9 ]{2,40}$/;

/** CSS custom properties from the resolved theme. Every value is re-checked here even though the API validated it. */
export function themeStyle(theme: Theme): CSSProperties {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(theme.colors)) if (/^[a-zA-Z]+$/.test(k) && HEX.test(v)) vars[`--c-${k}`] = v;
  const safeFont = (f: string, fallback: string) => (FONT.test(f) ? `'${f}', ${fallback}` : fallback);
  vars['--font-heading'] = safeFont(theme.headingFont, 'serif');
  vars['--font-body'] = safeFont(theme.bodyFont, 'system-ui, sans-serif');
  vars['--radius'] = `${Math.min(32, Math.max(0, Math.round(theme.radius)))}px`;
  vars['--btn-radius'] = theme.buttonShape === 'pill' ? '999px' : theme.buttonShape === 'square' ? '0' : 'var(--radius)';
  vars['--heading-transform'] = theme.headingStyle === 'uppercase' ? 'uppercase' : 'none';
  vars['--heading-fstyle'] = theme.headingStyle === 'italic' ? 'italic' : 'normal';
  vars['--space'] = theme.sectionSpacing === 'compact' ? '2.5rem' : theme.sectionSpacing === 'spacious' ? '6rem' : '4rem';
  return vars as CSSProperties;
}

export function fontsHref(theme: Theme): string | null {
  const names = [...new Set([theme.headingFont, theme.bodyFont])].filter((f) => FONT.test(f));
  if (names.length === 0) return null;
  const families = names.map((n) => `family=${n.replace(/ /g, '+')}:wght@400;500;600;700`).join('&');
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}
