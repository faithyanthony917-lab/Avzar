import type { ReactNode } from 'react';
import { longDate } from '@/lib/home-view';

/** The heading every signed-in page opens with: today's date in the business's time zone, the title (with optional status badges beside it), one line of help, an optional back link above, and optional actions. */
export function PageHead({ title, intro, zone, back, badges, children }: { title: string; intro?: string; zone: string; back?: ReactNode; badges?: ReactNode; children?: ReactNode }) {
  return (
    <header className="ap-pagehead">
      <div>
        {back && <p style={{ margin: '0 0 .5rem' }}>{back}</p>}
        <p className="ap-eyebrow">{longDate(zone)}</p>
        <h1>{title}{badges && <> {badges}</>}</h1>
        {intro && <p className="ap-foot ap-intro">{intro}</p>}
      </div>
      {children && <div className="ap-actions">{children}</div>}
    </header>
  );
}
