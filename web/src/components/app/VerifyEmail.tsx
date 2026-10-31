'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';

/**
 * POST /api/auth/confirm-email { userId, token } (accountRoutes.js:39). Confirms as soon as the page opens. This is safe to do on load:
 * the endpoint is a POST (a mail scanner's plain GET cannot trigger it), and the token only marks the address confirmed
 * (accountService.js:167-171), so running it twice is harmless.
 */
export function VerifyEmail({ userId, token }: { userId: string; token: string }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React runs effects twice in development; send the request once
    started.current = true;
    api('/api/auth/confirm-email', { method: 'POST', json: { userId, token } })
      .then(() => setState('done'))
      .catch((err) => { setError(messageFor(err)); setState('failed'); });
  }, [userId, token]);

  if (state === 'working') return <div className="ap-form" aria-busy="true"><h1>Confirming your email…</h1><p style={{ margin: 0 }} role="status">One moment.</p></div>;
  if (state === 'done') {
    return <div className="ap-form">
      <h1>Email confirmed</h1>
      <p role="status" style={{ margin: 0 }}>Thank you. Your email address is confirmed.</p>
      <Link className="ap-btn" href="/login" style={{ textDecoration: 'none', textAlign: 'center' }}>Go to sign in</Link>
    </div>;
  }
  return <div className="ap-form">
    <h1>We could not confirm your email</h1>
    <p role="alert" className="ap-alert">{error}</p>
    <p className="ap-foot">The link may have expired or been replaced by a newer one. Sign in, open Account security and choose “Resend verification email”.</p>
    <Link className="ap-btn" href="/login" style={{ textDecoration: 'none', textAlign: 'center' }}>Go to sign in</Link>
  </div>;
}
