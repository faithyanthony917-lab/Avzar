import type { Metadata } from 'next';
import Link from 'next/link';
import { InfoPage } from '@/components/site/InfoPage';
import { GUIDES } from '@/lib/guides';

export const metadata: Metadata = { title: 'Help guides · Avzar' };

export default function Help() {
  return (
    <InfoPage>
      <h1>Help guides</h1>
      <p className="lp-lead">Short, step-by-step guides for the things you do most.</p>
      <ul className="lp-guides">
        {GUIDES.map((g) => (
          <li key={g.slug}>
            <h2><Link href={`/help/${g.slug}`}>{g.title}</Link></h2>
            <p>{g.summary}</p>
          </li>
        ))}
      </ul>
      <p>Cannot find what you need? <Link href="/contact">Contact us</Link>.</p>
    </InfoPage>
  );
}
