'use client';

import Link from 'next/link';
import { useState } from 'react';
import '../../app/landing.css';
import { BrandLogo } from '@/components/BrandLogo';

const LINKS = [
  { href: '/#features', label: 'Features' },
  { href: '/#storefront', label: 'Storefront' },
  { href: '/#get-the-app', label: 'Get the app' },
  { href: '/help', label: 'Help' },
  { href: '/contact', label: 'Contact' },
];

/** Shared by the landing page and the information pages. A menu button replaces the links on small screens. */
export function PublicHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="lp-top">
      <div className="wrap lp-hdr">
        <BrandLogo href="/" className="lp-brand" size={32} />
        <nav aria-label="Main" className="lp-nav">
          {LINKS.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
        </nav>
        <div className="lp-hdr-actions">
          <Link href="/login" className="lp-link">Sign in</Link>
          <Link href="/dashboard" className="lp-btn lp-btn-sm">Open web app</Link>
          <button type="button" className="lp-burger" aria-expanded={open} aria-controls="lp-mpanel" onClick={() => setOpen((v) => !v)}>
            <span className="ap-sr">{open ? 'Close menu' : 'Open menu'}</span>
            <span aria-hidden="true" className="lp-burger-bars"><i /><i /><i /></span>
          </button>
        </div>
      </div>
      {open && (
        <nav id="lp-mpanel" aria-label="Menu" className="lp-mpanel">
          {LINKS.map((l) => <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>{l.label}</Link>)}
          <Link href="/dashboard" className="lp-btn" onClick={() => setOpen(false)}>Open web app</Link>
          <Link href="/register" onClick={() => setOpen(false)}>Create a business account</Link>
        </nav>
      )}
    </header>
  );
}
