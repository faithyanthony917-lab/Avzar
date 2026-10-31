import { DM_Sans, Manrope, Space_Mono } from 'next/font/google';

/**
 * Workshop type system, shared by the landing page, sign-in, customer portal and the signed-in app.
 *  - DM Sans: body and controls
 *  - Manrope: headings, numbers, the wordmark
 *  - Space Mono: small captions and counters
 * Public storefronts keep their own theme fonts.
 */
const sans = DM_Sans({ subsets: ['latin'], display: 'swap', weight: ['400', '500', '600', '700'], variable: '--font-sans' });
const head = Manrope({ subsets: ['latin'], display: 'swap', weight: ['500', '600', '700', '800'], variable: '--font-head' });
const mono = Space_Mono({ subsets: ['latin'], display: 'swap', weight: ['400', '700'], variable: '--font-mono' });

const variable = `${sans.variable} ${head.variable} ${mono.variable}`;

/** Kept under the old names so existing layouts do not change. Both expose the same three font variables. */
export const lpFont = { variable };
export const appFont = { variable };
