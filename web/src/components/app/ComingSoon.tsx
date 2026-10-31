'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * For things the workshop designs show but the backend cannot do yet. It looks like the real control;
 * clicking it says so, instead of leading nowhere. Swap it for the real control when the backend arrives.
 */
export function ComingSoon({ children, className, message = 'Coming soon. This is not available yet.' }: { children: ReactNode; className?: string; message?: string }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setTimeout(() => setShown(false), 3500);
    return () => clearTimeout(timer);
  }, [shown]);
  return (
    <span className="ap-soon-wrap">
      <button type="button" className={className} onClick={() => setShown(true)}>{children}</button>
      <span role="status" className="ap-soon-note">{shown ? message : ''}</span>
    </span>
  );
}
