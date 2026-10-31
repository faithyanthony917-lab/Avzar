import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDesign, mediaUrl } from '@/lib/api';
import { money, paragraphs } from '@/lib/format';
import type { DesignDetail, Page, RenderContext, Site } from '@/lib/types';
import InquiryForm from '@/components/InquiryForm';
import { SectionView } from '@/components/sections';
import { ReadyToWearCheckout } from '@/components/ReadyToWearCheckout';

export function findPage(site: Site, segments: string[]): Page | null {
  const slug = segments.length === 0 ? '' : segments.join('/');
  return site.document.pages.find((p) => p.slug === slug && p.kind !== 'design') ?? null;
}

export function siteMetadata(site: Site, page: Page | null, designTitle?: string, designDescription?: string, image?: string | null): Metadata {
  const title = designTitle ?? page?.seo.title ?? (page?.kind === 'home' ? site.name : `${page?.title ?? ''} | ${site.name}`);
  const description = designDescription ?? page?.seo.description ?? site.document.branding.tagline ?? undefined;
  const share = image ?? mediaUrl(page?.seo.shareImageMediaId ?? site.document.branding.shareImageMediaId, 'md');
  const favicon = mediaUrl(site.document.branding.faviconMediaId, 'sm');
  return {
    title, description,
    robots: site.allowSearchIndexing ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { title, description, siteName: site.name, type: 'website', images: share ? [share] : undefined },
    icons: favicon ? { icon: favicon } : undefined,
  };
}

export async function PageView({ site, base, page }: { site: Site; base: string; page: Page }) {
  const ctx: RenderContext = { site, base };
  const sections = page.sections.filter((s) => s.visible);
  const firstHero = sections.findIndex((s) => s.type === 'hero');
  const hasHeading = sections.some((s) => (s.type === 'hero' && !!s.props.headline));
  return (
    <>
      {!hasHeading ? <div className="wrap page-title"><h1>{page.title}</h1></div> : null}
      {await Promise.all(sections.map(async (s, i) => <SectionView key={s.id} ctx={ctx} section={s} first={i === firstHero} />))}
      {site.templateKey === 'ready-to-wear' ? <ReadyToWearCheckout slug={site.slug} /> : null}
    </>
  );
}

export async function renderSitePage(site: Site, base: string, segments: string[]) {
  const page = findPage(site, segments);
  if (!page || !page.visible) notFound();
  return <PageView site={site} base={base} page={page} />;
}

export async function loadDesign(site: Site, designSlug: string): Promise<DesignDetail> {
  const design = await getDesign(site.slug, designSlug);
  if (!design) notFound();
  return design;
}

export async function DesignPageView({ site, base, design }: { site: Site; base: string; design: DesignDetail }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const ctx: RenderContext = { site, base, design };
  const template = site.document.pages.find((p) => p.kind === 'design');
  const extra = (template?.sections ?? []).filter((s) => s.visible);
  const hasForm = extra.some((s) => ['inquiryForm', 'customOrderForm', 'booking'].includes(s.type));
  const price = money(design.basePrice, design.currencyCode);
  const hero = design.images[0];
  const ld = {
    '@context': 'https://schema.org', '@type': 'Product', name: design.name, description: design.description ?? undefined,
    image: design.images.map((i) => mediaUrl(i.mediaId, 'md')).filter(Boolean),
    offers: design.basePrice != null && design.currencyCode ? { '@type': 'Offer', price: design.basePrice, priceCurrency: design.currencyCode } : undefined,
  };

  return (
    <>
      {/* JSON-LD for search engines. The value is JSON.stringify output with "<" escaped, so it cannot close the script element. */}
      <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <article className="wrap design">
        <p className="crumb"><Link href={base || '/'}>Home</Link> / {design.categoryName ?? 'Designs'}</p>
        <div className="design-grid">
          <div className="design-media">
            {hero ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={mediaUrl(hero.mediaId, 'orig')!} alt={hero.alt ?? design.name} className="design-hero" /> : <div className="design-hero ph" aria-hidden="true" />}
            {design.images.length > 1 ? (
              <ul className="thumbs" role="list">
                {design.images.slice(1).map((i) => (/* eslint-disable-next-line @next/next/no-img-element */ <li key={i.mediaId}><img src={mediaUrl(i.mediaId, 'sm')!} alt={i.alt ?? design.name} loading="lazy" /></li>))}
              </ul>
            ) : null}
          </div>
          <div className="design-info">
            <h1>{design.name}</h1>
            <p className="price">{price ?? 'Price on request'}</p>
            {paragraphs(design.description).map((t, i) => <p key={i}>{t}</p>)}
            <dl className="specs">
              {design.garmentType ? <><dt>Type</dt><dd>{design.garmentType}</dd></> : null}
              {design.fabrics.length ? <><dt>Fabrics</dt><dd>{design.fabrics.join(', ')}</dd></> : null}
              {design.colours.length ? <><dt>Colours</dt><dd>{design.colours.join(', ')}</dd></> : null}
              {design.sizes.length ? <><dt>Sizes</dt><dd>{design.sizes.join(', ')}</dd></> : null}
              {design.productionDays ? <><dt>Made in</dt><dd>about {design.productionDays} days</dd></> : null}
            </dl>
            {!hasForm && site.workflows.includes('inquiry') ? (
              <InquiryForm slug={site.slug} kind="Quotation" heading="Ask about this design" designId={design.id} designName={design.name} disabled={site.isPreview} />
            ) : null}
          </div>
        </div>
      </article>
      {await Promise.all(extra.map(async (s) => <SectionView key={s.id} ctx={ctx} section={s} />))}
    </>
  );
}
