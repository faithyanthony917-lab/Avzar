/**
 * Pure helpers for the guided storefront editor: template lock reasons, which theme controls a plan unlocks,
 * generated content fields, and small client-side checks. The backend stays the authority; nothing here relaxes a rule.
 */

export type Capabilities = {
  builder: boolean; themeLevel: string; brandingLevel: string; sectionLevel: string; templateTier: string;
  customPages: boolean; maxPages: number | null;
};
export type PropSpec = {
  name: string; kind: string; max: number; min: number; required: boolean; multiline: boolean; itemMax: number;
  fields: PropSpec[] | null;
};
export type TemplateInfo = { key: string; name: string; description: string; tier: string; allowed: boolean; sample?: boolean };
export type Props = Record<string, unknown>;

const PLAN_FOR_TIER: Record<string, string> = { standard: 'Free', basic: 'Starter', advanced: 'Professional', premium: 'Business' };
const TIERS = ['standard', 'basic', 'advanced', 'premium'];
const LEVELS = ['none', 'basic', 'advanced', 'full'];

export const planForTier = (tier: string) => PLAN_FOR_TIER[tier] ?? tier;

const PLAN_CODE_FOR_TIER: Record<string, string> = { standard: 'free', basic: 'starter', advanced: 'professional', premium: 'business' };

/** The billing page, with the plan that includes this template tier highlighted. Null when the tier is unknown. */
export function upgradePath(tier: string): string | null {
  const code = PLAN_CODE_FOR_TIER[tier];
  return code && code !== 'free' ? `/settings/billing?plan=${code}` : null;
}

/** Only a plan code in the form the billing page expects is passed on; anything else is ignored. */
export function planFromQuery(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(first) ? first : null;
}

export type TemplateStatus =
  | { state: 'current' }
  | { state: 'available' }
  | { state: 'locked'; reason: string };

/** What the gallery shows for one template, before the owner clicks it. */
export function templateStatus(template: TemplateInfo, currentKey: string, capabilities: Pick<Capabilities, 'templateTier'>): TemplateStatus {
  if (template.key === currentKey) return { state: 'current' };
  if (template.allowed) return { state: 'available' };
  const yours = planForTier(capabilities.templateTier);
  return { state: 'locked', reason: `From the ${planForTier(template.tier)} plan (yours: ${yours}).` };
}

export const tierRank = (tier: string) => TIERS.indexOf(tier);

/** Why structure editing is off, or null when the plan has the visual builder. */
export function structureLockReason(capabilities: Pick<Capabilities, 'builder'>): string | null {
  return capabilities.builder ? null
    : 'Adding, removing and reordering sections, changing layouts, and custom pages need a plan with the visual builder. You can still edit all the text, images and contact details on your pages, and hide or show sections.';
}

/** Sections customers use to reach the shop. Plans without the builder cannot hide them (the backend enforces the same list). */
export const ALWAYS_VISIBLE_TYPES: readonly string[] = ['inquiryForm', 'booking', 'customOrderForm', 'contactInfo'];

/** Why a visible section cannot be hidden on a plan without the builder, or null when it can. Showing a hidden section is always allowed. */
export function hideBlockReason(sections: { type: string; visible: boolean }[], index: number): string | null {
  const section = sections[index];
  if (!section || !section.visible) return null;
  if (ALWAYS_VISIBLE_TYPES.includes(section.type)) return 'Customers use this section to reach you, so it stays visible on your plan.';
  if (!sections.some((other, i) => i !== index && other.visible)) return 'Each page keeps at least one visible section.';
  return null;
}

/** The current official link of a shop: `<site>/sites/<slug>` on the address the owner is using (decision 7). Empty until the origin is known. */
export function officialSiteUrl(origin: string, slug: string): string {
  return origin ? `${origin.replace(/\/+$/, '')}/sites/${encodeURIComponent(slug)}` : '';
}

export type PreviewDevice = 'phone' | 'desktop' | 'fit';
export const PREVIEW_DEVICES: { key: PreviewDevice; label: string }[] = [{ key: 'phone', label: 'Phone' }, { key: 'desktop', label: 'Desktop' }, { key: 'fit', label: 'Whole page' }];

/** Address of the private draft preview for a token returned by the preview-link route. */
export const previewPath = (token: string): string => `/preview/${encodeURIComponent(token)}`;

/** True when the editor holds changes that the preview (the last saved draft) does not show yet. */
export const hasUnsavedChanges = (savedJson: string, current: unknown): boolean => savedJson !== '' && savedJson !== JSON.stringify(current);

export const COLOR_KEYS = ['primary', 'secondary', 'accent', 'background', 'text', 'heading', 'button', 'buttonText', 'nav', 'navText', 'footer', 'footerText', 'card', 'border'] as const;
export const COLOR_LABELS: Record<string, string> = {
  primary: 'Main colour', secondary: 'Second colour', accent: 'Accent', background: 'Page background', text: 'Body text', heading: 'Headings',
  button: 'Button', buttonText: 'Button text', nav: 'Menu background', navText: 'Menu text', footer: 'Footer background', footerText: 'Footer text',
  card: 'Cards', border: 'Borders',
};

export type ThemeAbilities = {
  choosePreset: boolean; colorKeys: readonly string[]; chooseFonts: boolean; chooseStyle: boolean;
  presetReason: string | null; colorReason: string | null; fontReason: string | null;
};

/** The same thresholds the backend applies in planViolations (theme level: none, basic, advanced, full). */
export function themeAbilities(capabilities: Pick<Capabilities, 'themeLevel'>): ThemeAbilities {
  const level = Math.max(0, LEVELS.indexOf(capabilities.themeLevel));
  return {
    choosePreset: level >= 1,
    colorKeys: level < 1 ? [] : level < 2 ? ['primary', 'accent'] : COLOR_KEYS,
    chooseFonts: level >= 2,
    chooseStyle: level >= 3,
    presetReason: level >= 1 ? null : 'Choosing a different colour theme is not included in your plan.',
    colorReason: level >= 2 ? null : level === 1 ? 'Your plan lets you change the main colour and the accent. Other colours need a higher plan.' : 'Changing colours is not included in your plan.',
    fontReason: level >= 2 ? null : 'Choosing fonts is not included in your plan.',
  };
}

export type BrandingAbilities = { logo: boolean; tagline: boolean; logoReason: string | null; taglineReason: string | null };

/** Same thresholds as the backend: logo from the basic branding level, tagline from the full level. */
export function brandingAbilities(capabilities: Pick<Capabilities, 'brandingLevel'>): BrandingAbilities {
  const level = Math.max(0, LEVELS.indexOf(capabilities.brandingLevel));
  return {
    logo: level >= 1, tagline: level >= 3,
    logoReason: level >= 1 ? null : 'A logo is not included in your plan.',
    taglineReason: level >= 3 ? null : 'A tagline is not included in your plan.',
  };
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
/** '#a1b2c3' for a valid six-digit colour, otherwise null. */
export function normalizeHex(input: string): string | null {
  const value = input.trim();
  const withHash = value.startsWith('#') ? value : `#${value}`;
  return HEX.test(withHash) ? withHash.toUpperCase() : null;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
export function contrastRatio(first: string, second: string): number {
  const [a, b] = [luminance(first), luminance(second)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

const PAIRS: [string, string, number][] = [
  ['text', 'background', 4.5], ['heading', 'background', 3], ['text', 'card', 4.5],
  ['buttonText', 'button', 4.5], ['navText', 'nav', 4.5], ['footerText', 'footer', 4.5],
];
export type ContrastIssue = { foreground: string; background: string; ratio: number; required: number };

/** Live contrast check for the colours as currently chosen (the server repeats it on save). */
export function contrastIssues(colors: Record<string, string>): ContrastIssue[] {
  return PAIRS.flatMap(([fg, bg, required]) => {
    const f = colors[fg]; const b = colors[bg];
    if (!f || !b || !HEX.test(f) || !HEX.test(b)) return [];
    const ratio = Math.round(contrastRatio(f, b) * 100) / 100;
    return ratio < required ? [{ foreground: fg, background: bg, ratio, required }] : [];
  });
}

/** Colours to start from: the preset's colours with any overrides on top. */
export function effectiveColors(presetColors: Record<string, string>, overrides: Record<string, string> | undefined): Record<string, string> {
  return { ...presetColors, ...(overrides ?? {}) };
}

/** Text, number, yes/no, image and link fields are edited directly; lists get their own item editor. */
export const isScalarKind = (kind: string) => ['Text', 'Bool', 'Int', 'Guid', 'Link'].includes(kind);

/** Short message for a value that would fail the server's check, or null. */
export function fieldIssue(spec: PropSpec, value: unknown): string | null {
  if (spec.kind === 'Text') {
    const text = typeof value === 'string' ? value : '';
    if (spec.required && !text.trim()) return 'This field is required.';
    if (spec.max > 0 && text.length > spec.max) return `Use at most ${spec.max} characters (now ${text.length}).`;
    if (/<\s*\/?\s*script/i.test(text)) return 'Scripts are not allowed here.';
  }
  if (spec.kind === 'Int' && value !== undefined && value !== null && value !== '') {
    const n = Number(value);
    if (!Number.isInteger(n)) return 'Enter a whole number.';
    if (spec.min && n < spec.min) return `Use ${spec.min} or more.`;
    if (spec.max && n > spec.max) return `Use ${spec.max} or less.`;
  }
  return null;
}

export function setProp(props: Props, name: string, value: unknown): Props {
  const next: Props = { ...props };
  if (value === undefined || value === null || value === '') delete next[name]; else next[name] = value;
  return next;
}

type Item = Record<string, unknown>;
const itemsOf = (props: Props, list: string): Item[] => (Array.isArray(props[list]) ? (props[list] as Item[]) : []);

export function setItemProp(props: Props, list: string, index: number, field: string, value: unknown): Props {
  const items = itemsOf(props, list).map((item, i) => {
    if (i !== index) return item;
    const copy: Item = { ...item };
    if (value === undefined || value === null || value === '') delete copy[field]; else copy[field] = value;
    return copy;
  });
  return { ...props, [list]: items };
}

/** An empty item for a list, with its required text fields present so the form can show them. */
export function newItem(spec: PropSpec): Item {
  const item: Item = {};
  for (const child of spec.fields ?? []) if (child.kind === 'Text' && child.required) item[child.name] = '';
  return item;
}
export function addItem(props: Props, spec: PropSpec): Props {
  const items = itemsOf(props, spec.name);
  if (spec.max > 0 && items.length >= spec.max) return props;
  return { ...props, [spec.name]: [...items, newItem(spec)] };
}
export function removeItem(props: Props, list: string, index: number): Props {
  return { ...props, [list]: itemsOf(props, list).filter((_, i) => i !== index) };
}

/** Plain-language label from a prop name: 'buttonLabel' becomes 'Button label'. */
export function labelFor(name: string): string {
  const base = name.replace(/MediaId$/, '');
  const named = base !== name && !/image/i.test(base) ? `${base} image` : base;
  const words = named.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type SwitchAddition = { type: string; variant: string; page: string };

/**
 * True when switching to another template should ask whether to add that template's own sections: the draft lacks some of
 * them and the plan may add sections (the backend enforces the plan; this only decides whether to ask).
 */
export function switchNeedsChoice(plan: { additions: readonly SwitchAddition[]; canAddSections: boolean }, fromKey: string, toKey: string): boolean {
  return fromKey !== toKey && plan.canAddSections && plan.additions.length > 0;
}

/** One short line per section a switch would add, such as 'Hero · Home'. `labelOf` turns a section type into its plain-language name. */
export function describeAdditions(additions: readonly SwitchAddition[], labelOf: (type: string) => string): string[] {
  return additions.map((item) => `${labelOf(item.type)} \u00b7 ${item.page}`);
}

/** What the owner is told after a template has been applied to the draft. */
export function switchSuccessMessage(name: string, archived: number, added: number): string {
  const parts = [`${name} template applied to your draft.`];
  if (added > 0) parts.push(`${added} section${added === 1 ? '' : 's'} from the template ${added === 1 ? 'was' : 'were'} added after your own.`);
  if (archived > 0) parts.push(`${archived} section(s) it does not support were set aside and return if you switch back.`);
  parts.push('Publish when you are happy.');
  return parts.join(' ');
}
