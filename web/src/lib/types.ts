// Mirrors the API's public contracts. The API camel-cases everything.

export type Theme = {
  colors: Record<string, string>;
  headingFont: string;
  bodyFont: string;
  headingStyle: string;
  buttonShape: string;
  radius: number;
  sectionSpacing: string;
};

export type SectionStyle = {
  background?: string | null;
  backgroundMediaId?: string | null;
  align: string;
  spacing: string;
  textColor?: string | null;
  buttonShape?: string | null;
};

export type Section = {
  id: string;
  type: string;
  variant: string;
  visible: boolean;
  props: Record<string, unknown>;
  style: SectionStyle;
};

export type Page = {
  id: string;
  kind: string;
  slug: string;
  title: string;
  visible: boolean;
  seo: { title?: string | null; description?: string | null; shareImageMediaId?: string | null };
  sections: Section[];
};

export type SiteDocument = {
  schemaVersion: number;
  templateKey: string;
  theme: unknown;
  branding: {
    logoMediaId?: string | null;
    logoWidth: number;
    logoPlacement: string;
    faviconMediaId?: string | null;
    shareImageMediaId?: string | null;
    tagline?: string | null;
    footerText?: string | null;
    socialLinks: { network: string; url: string }[];
  };
  navigation: { label: string; pageId: string; visible: boolean }[];
  pages: Page[];
};

export type Site = {
  name: string;
  slug: string;
  businessName: string;
  currencyCode: string;
  templateKey: string;
  versionNumber: number;
  isPreview: boolean;
  /** A private preview that shows a template's starter with the shop's name, not the saved draft. */
  isSample?: boolean;
  /** The business switched storefront analytics on. Visitors are still only counted after they accept (see storefront-consent.ts). */
  analyticsEnabled?: boolean;
  document: SiteDocument;
  theme: Theme;
  contact: { email?: string | null; phone?: string | null; address?: string | null; openingHours?: string | null };
  workflows: string[];
  allowSearchIndexing: boolean;
};

export type DesignSummary = {
  id: string; name: string; slug: string; kind: string; categoryName?: string | null; basePrice?: number | null;
  currencyCode?: string | null; isFeatured: boolean; coverMediaId?: string | null; coverAlt?: string | null;
};

export type DesignDetail = {
  id: string; name: string; slug: string; description?: string | null; kind: string; categoryName?: string | null;
  garmentType?: string | null; tags: string[]; fabrics: string[]; colours: string[]; sizes: string[];
  basePrice?: number | null; currencyCode?: string | null; productionDays?: number | null;
  images: { mediaId: string; alt?: string | null }[];
};

export type Paged<T> = { items: T[]; page: number; pageSize: number; totalCount: number };
export type Collection = { id: string; name: string; slug: string; description?: string | null; designs: DesignSummary[] };

/** What a section needs to know about where it is being rendered. */
export type RenderContext = { site: Site; base: string; design?: DesignDetail };
