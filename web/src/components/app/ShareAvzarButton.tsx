'use client';

import { toast } from '@/lib/toast';

const SHARE_TEXT = 'Avzar helps tailors and fashion makers run their workshop: customers, measurements, orders and payments in one place.';

/**
 * Shares the public Avzar site. Uses the phone's share sheet when there is one; otherwise copies the link;
 * if copying is blocked too, shows the link in a message so it can be copied by hand.
 */
export function ShareAvzarButton({ className }: { className?: string }) {
  async function share() {
    const url = window.location.origin;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'Avzar', text: SHARE_TEXT, url });
        return;
      } catch (e) {
        // Closing the share sheet is a choice, not a failure.
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // Any other failure falls through to copying the link.
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied. Paste it anywhere to share Avzar.');
    } catch {
      toast.error(`Could not copy automatically. The link is ${url}`);
    }
  }

  return <button type="button" className={className} onClick={() => void share()}>Share Avzar</button>;
}
