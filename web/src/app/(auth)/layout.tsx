import Link from 'next/link';
import type { Metadata } from 'next';
import { lpFont } from '../fonts';
import { BrandLogo } from '@/components/BrandLogo';
import '../app.css';

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`ap ap-auth ap-auth-split ${lpFont.variable}`}>
      <aside className="ap-auth-brand">
        <BrandLogo href="/" className="ap-logo ap-auth-logo" />
        <div>
          <p className="ap-auth-lead">Your whole workshop, in one place.</p>
          <ul className="ap-auth-points">
            <li>Orders and fittings, from the first quote to delivery</li>
            <li>Customers, measurements and payments kept together</li>
            <li>A storefront of your own, ready for new clients</li>
          </ul>
        </div>
        <div className="ap-auth-tape" aria-hidden="true" />
      </aside>
      <div className="ap-auth-pane">
        <header className="ap-authbar">
          <BrandLogo href="/" className="ap-logo ap-auth-mobilelogo" />
          <Link href="/" className="ap-link">Back to home</Link>
        </header>
        <main className="ap-card">{children}</main>
      </div>
    </div>
  );
}
