import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InfoPage } from '@/components/site/InfoPage';
import { GUIDES } from '@/lib/guides';

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const g = GUIDES.find((x) => x.slug === slug);

  return {
    title: g ? `${g.title} · Avzar help` : 'Help · Avzar',
  };
}

export default async function Guide({ params }: Props) {
  const { slug } = await params;
  const g = GUIDES.find((x) => x.slug === slug);

  if (!g) notFound();

  return (
    <InfoPage>
      <p>
        <Link href="/help">All guides</Link>
      </p>

      <h1>{g.title}</h1>
      <p className="lp-lead">{g.summary}</p>

      <ol className="lp-steps">
        {g.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>

      {g.tip && (
        <p className="lp-tip">
          <strong>Tip:</strong> {g.tip}
        </p>
      )}

      <p>
        Still stuck? <Link href="/contact">Contact us</Link>.
      </p>
    </InfoPage>
  );
}
