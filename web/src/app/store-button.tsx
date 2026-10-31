'use client';

import { useState } from 'react';

type Props = { eyebrow: string; store: string; message: string };

/** Store listing is not live yet: clicking shows a "coming soon" note instead of navigating. */
export default function StoreButton({ eyebrow, store, message }: Props) {
  const [shown, setShown] = useState(false);
  return (
    <div className="lp-store">
      <button type="button" className="lp-store-btn" aria-describedby={shown ? `${store}-note` : undefined} onClick={() => setShown(true)}>
        <span className="lp-store-small">{eyebrow}</span>
        <span className="lp-store-big">{store}</span>
      </button>
      <p id={`${store}-note`} role="status" className="lp-store-note">{shown ? message : ''}</p>
    </div>
  );
}
