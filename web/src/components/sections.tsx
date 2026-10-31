import Link from 'next/link';
import { getCollection, getDesigns, mediaUrl } from '@/lib/api';
import { bool, list, money, num, paragraphs, str } from '@/lib/format';
import { resolveLink } from '@/lib/links';
import type { DesignSummary, RenderContext, Section } from '@/lib/types';
import InquiryForm from './InquiryForm';

/**
 * The CONTROLLED component library: one component per section type in the schema. A section is rendered only if its
 * type is in this table, and every value is rendered as a React text node or a validated attribute. There is no
 * dangerouslySetInnerHTML anywhere, so saved content can never become markup or script.
 */

function Heading({ text, level = 2, id }: { text: string; level?: 1 | 2 | 3; id?: string }) {
  if (!text) return null;
  const Tag = (`h${level}`) as 'h1' | 'h2' | 'h3';
  return <Tag id={id} className="sec-h">{text}</Tag>;
}

function Button({ ctx, target, label, shape }: { ctx: RenderContext; target: unknown; label: string; shape?: string | null }) {
  if (!label) return null;
  const { href, external } = resolveLink(ctx.site, ctx.base, target);
  const cls = `btn${shape ? ` btn-${shape}` : ''}`;
  return external
    ? <a className={cls} href={href} target="_blank" rel="noopener noreferrer">{label}</a>
    : <Link className={cls} href={href}>{label}</Link>;
}

function Img({ id, alt, variant = 'md', className, priority }: { id?: string | null; alt: string; variant?: 'sm' | 'md' | 'orig'; className?: string; priority?: boolean }) {
  const src = mediaUrl(id, variant);
  if (!src) return null;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} loading={priority ? 'eager' : 'lazy'} decoding="async" />;
}

function DesignCards({ ctx, designs, showPrices }: { ctx: RenderContext; designs: DesignSummary[]; showPrices: boolean }) {
  if (designs.length === 0) return <p className="muted">New designs are coming soon.</p>;
  return (
    <ul className="cards" role="list">
      {designs.map((d) => (
        <li key={d.id} className="card">
          <Link href={`${ctx.base}/design/${d.slug}`} className="card-link">
            {d.coverMediaId ? <Img id={d.coverMediaId} alt={d.coverAlt ?? d.name} variant="md" className="card-img" /> : <div className="card-img ph" aria-hidden="true" />}
            <span className="card-name">{d.name}</span>
            {d.categoryName ? <span className="card-meta">{d.categoryName}</span> : null}
            {showPrices ? <span className="card-price">{money(d.basePrice, d.currencyCode) ?? 'Price on request'}</span> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

async function DesignsSection({ ctx, s, mode }: { ctx: RenderContext; s: Section; mode: 'list' | 'featured' }) {
  const p = s.props;
  const limit = num(p.limit, mode === 'featured' ? 6 : 12);
  const res = await getDesigns(ctx.site.slug, {
    categoryId: mode === 'list' ? (str(p.categoryId) || undefined) : undefined,
    featured: mode === 'featured' || bool(p.featuredOnly) ? true : undefined,
    pageSize: limit,
  });
  return <><Heading text={str(p.heading)} /><DesignCards ctx={ctx} designs={res?.items ?? []} showPrices={bool(p.showPrices)} /></>;
}

async function CollectionSection({ ctx, s }: { ctx: RenderContext; s: Section }) {
  // The document stores the collection id; the public API serves collections by slug, so look it up through the list of the site's designs.
  // A collection that is private, missing or empty renders as nothing, never as an error page.
  const id = str(s.props.collectionId);
  if (!id) return null;
  const res = await getCollection(ctx.site.slug, id).catch(() => null);
  const designs = (res?.designs ?? []).slice(0, num(s.props.limit, 12));
  if (designs.length === 0) return null;
  return <><Heading text={str(s.props.heading) || res?.name || ''} /><DesignCards ctx={ctx} designs={designs} showPrices={bool(s.props.showPrices)} /></>;
}

function Contact({ ctx, s }: { ctx: RenderContext; s: Section }) {
  const c = ctx.site.contact; const p = s.props;
  return (
    <>
      <Heading text={str(p.heading) || 'Contact us'} />
      <address className="contact">
        {bool(p.showAddress) && c.address ? <p>{c.address}</p> : null}
        {bool(p.showPhone) && c.phone ? <p><a href={`tel:${c.phone.replace(/[^+\d]/g, '')}`}>{c.phone}</a></p> : null}
        {bool(p.showEmail) && c.email ? <p><a href={`mailto:${c.email}`}>{c.email}</a></p> : null}
        {bool(p.showHours) && c.openingHours ? <p className="muted">{c.openingHours}</p> : null}
        {str(p.note) ? <p className="muted">{str(p.note)}</p> : null}
      </address>
    </>
  );
}

function Body({ text }: { text: unknown }) {
  return <>{paragraphs(text).map((t, i) => <p key={i}>{t}</p>)}</>;
}

export async function SectionView({ ctx, section: s, first }: { ctx: RenderContext; section: Section; first?: boolean }): Promise<React.ReactNode> {
  const p = s.props;
  const slug = ctx.site.slug;
  const preview = ctx.site.isPreview;
  const style = {
    background: s.style.background ?? undefined,
    color: s.style.textColor ?? undefined,
  } as React.CSSProperties;
  const bg = mediaUrl(s.style.backgroundMediaId, 'orig');
  if (bg) (style as Record<string, string>).backgroundImage = `url("${bg}")`;
  const wrap = (children: React.ReactNode) => (
    <section id={`sec-${s.id}`} className={`sec sec-${s.type} v-${s.variant} al-${s.style.align} sp-${s.style.spacing}${s.style.buttonShape ? ` bs-${s.style.buttonShape}` : ''}`} style={style}>
      <div className="wrap">{children}</div>
    </section>
  );
  const contextDesign = ctx.design;

  switch (s.type) {
    case 'hero':
      return wrap(
        <div className="hero-grid">
          <div className="hero-copy">
            <Heading text={str(p.headline)} level={first ? 1 : 2} />
            {str(p.subheadline) ? <p className="lead">{str(p.subheadline)}</p> : null}
            <Button ctx={ctx} target={p.buttonTarget} label={str(p.buttonLabel)} shape={s.style.buttonShape} />
          </div>
          {str(p.imageMediaId) ? <Img id={str(p.imageMediaId)} alt="" variant="orig" className="hero-img" priority={first} /> : null}
        </div>,
      );
    case 'designList': return wrap(await DesignsSection({ ctx, s, mode: 'list' }));
    case 'featuredDesigns': return wrap(await DesignsSection({ ctx, s, mode: 'featured' }));
    case 'collection': return wrap(await CollectionSection({ ctx, s }));
    case 'about':
      return wrap(<div className="split"><div><Heading text={str(p.heading)} /><Body text={p.body} /></div>{str(p.imageMediaId) ? <Img id={str(p.imageMediaId)} alt="" className="side-img" /> : null}</div>);
    case 'richText':
      return wrap(<><Heading text={str(p.heading)} /><div className="prose"><Body text={p.body} /></div></>);
    case 'contactInfo': return wrap(<Contact ctx={ctx} s={s} />);
    case 'inquiryForm':
      return wrap(<InquiryForm slug={slug} kind={contextDesign ? 'Quotation' : 'Inquiry'} heading={str(p.heading)} intro={str(p.intro)} designId={contextDesign?.id} designName={contextDesign?.name} disabled={preview} />);
    case 'booking':
      return wrap(<InquiryForm slug={slug} kind="Appointment" heading={str(p.heading)} intro={str(p.intro)} designId={contextDesign?.id} designName={contextDesign?.name} disabled={preview} />);
    case 'customOrderForm':
      return wrap(<InquiryForm slug={slug} kind="OrderRequest" heading={str(p.heading)} intro={str(p.intro)} designId={contextDesign?.id} designName={contextDesign?.name} disabled={preview} />);
    case 'gallery': {
      const images = list<{ mediaId?: string; alt?: string; caption?: string }>(p.images).filter((i) => i.mediaId);
      return wrap(
        <>
          <Heading text={str(p.heading)} />
          {images.length === 0 ? null : (
            <ul className={`gallery cols-${num(p.columns, 3)}`} role="list">
              {images.map((i, n) => (
                <li key={`${i.mediaId}-${n}`}><figure><Img id={i.mediaId} alt={str(i.alt)} />{str(i.caption) ? <figcaption>{str(i.caption)}</figcaption> : null}</figure></li>
              ))}
            </ul>
          )}
        </>,
      );
    }
    case 'services':
      return wrap(<><Heading text={str(p.heading)} /><ul className="tiles" role="list">{list<{ title?: string; description?: string; priceText?: string }>(p.items).map((i, n) => (
        <li key={n} className="tile"><h3>{str(i.title)}</h3><p>{str(i.description)}</p>{str(i.priceText) ? <p className="tile-price">{str(i.priceText)}</p> : null}</li>))}</ul></>);
    case 'designerProfile':
      return wrap(<div className="split"><div><h2 className="sec-h">{str(p.name)}</h2>{str(p.role) ? <p className="muted">{str(p.role)}</p> : null}<Body text={p.bio} /></div>{str(p.imageMediaId) ? <Img id={str(p.imageMediaId)} alt={str(p.name)} className="side-img" /> : null}</div>);
    case 'testimonials':
      return wrap(<><Heading text={str(p.heading)} /><ul className="tiles" role="list">{list<{ quote?: string; author?: string; role?: string }>(p.items).map((i, n) => (
        <li key={n} className="tile"><blockquote><p>{str(i.quote)}</p>{str(i.author) ? <footer>{str(i.author)}{str(i.role) ? `, ${str(i.role)}` : ''}</footer> : null}</blockquote></li>))}</ul></>);
    case 'pricing':
      return wrap(<><Heading text={str(p.heading)} /><ul className="tiles" role="list">{list<{ name?: string; price?: string; features?: string[]; highlight?: boolean }>(p.tiers).map((t, n) => (
        <li key={n} className={`tile${t.highlight ? ' hi' : ''}`}><h3>{str(t.name)}</h3><p className="tile-price">{str(t.price)}</p><ul>{(t.features ?? []).map((f, k) => <li key={k}>{str(f)}</li>)}</ul></li>))}</ul></>);
    case 'faq':
      return wrap(<><Heading text={str(p.heading)} /><div className="faq">{list<{ question?: string; answer?: string }>(p.items).map((i, n) => (
        <details key={n}><summary>{str(i.question)}</summary><Body text={i.answer} /></details>))}</div></>);
    default:
      return null; // an unknown type (a newer schema than this site) is skipped, never rendered raw
  }
}
