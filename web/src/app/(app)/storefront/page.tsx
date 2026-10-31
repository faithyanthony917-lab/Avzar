import { LoadError, NoAccess } from '@/components/app/Notices';
import { StorefrontManager } from '@/components/app/StorefrontManager';
import { getSession, serverGet } from '@/lib/session';
import { can } from '@/lib/team';
import type { PropSpec } from '@/lib/storefront-guided';

export const metadata = { title: 'Storefront builder · Avzar' };
export const dynamic = 'force-dynamic';

type StorefrontSummary = {
  id: string; name: string; slug: string; status: string; templateKey: string;
  publishedVersion: number | null; draftRevision: number; hasUnpublishedChanges: boolean; updatedAtUtc: string;
};
type Catalog = {
  templates: { key: string; name: string; description: string; tier: string; allowed: boolean; supported: Record<string, string[]> }[];
  sectionTypes: { type: string; label: string; minLevel: string; variants: string[]; allowed: boolean; props: { name: string; kind: string; max: number; min: number; required: boolean; multiline: boolean; itemMax: number; fields: PropSpec[] | null }[] }[];
  themes: { key: string; name: string; colors: Record<string, string>; headingFont: string; bodyFont: string }[];
  fonts: string[];
  presets: { key: string; name: string; sectionType: string; variant: string; props: unknown; style: unknown; isBuiltIn: boolean }[];
  capabilities: { builder: boolean; themeLevel: string; brandingLevel: string; sectionLevel: string; templateTier: string; customPages: boolean; customDomain: boolean; maxPages: number | null; maxStorefronts: number | null };
};

export default async function StorefrontPage() {
  const me = (await getSession())!;
  if (!can(me, 'storefront.view')) return <NoAccess />;
  const [sites, catalog] = await Promise.all([
    serverGet<StorefrontSummary[]>('/api/storefronts'),
    serverGet<Catalog>('/api/storefront-builder/catalog'),
  ]);
  if (!sites.ok) return <LoadError status={sites.status} />;
  if (!catalog.ok) return <LoadError status={catalog.status} />;
  return <StorefrontManager initialSites={sites.data} catalog={catalog.data} canEdit={can(me, 'storefront.edit')} canPublish={can(me, 'storefront.publish')} canViewMedia={can(me, 'media.view')} canManageMedia={can(me, 'media.manage')} zone={me.timeZoneId} />;
}
