import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getCollection, getSite } from '@/lib/api';
import { money } from '@/lib/format';
import Link from 'next/link';

type Props = { params: Promise<{ slug: string; collectionSlug: string }> };

export default async function CollectionPage({ params }: Props) {
  const { slug, collectionSlug } = await params;
  const [site, col] = await Promise.all([getSite(slug), getCollection(slug, collectionSlug)]);
  if (!site || !col) notFound();
  const base = (await headers()).get('x-site-root') ? '' : `/sites/${slug}`;
  return (
    <section className="sec sp-comfortable"><div className="wrap">
      <h1>{col.name}</h1>
      {col.description ? <p className="lead">{col.description}</p> : null}
      <ul className="cards" role="list">
        {col.designs.map((d) => (
          <li key={d.id} className="card"><Link href={`${base}/design/${d.slug}`} className="card-link">
            <span className="card-name">{d.name}</span><span className="card-price">{money(d.basePrice, d.currencyCode) ?? 'Price on request'}</span>
          </Link></li>
        ))}
      </ul>
    </div></section>
  );
}
