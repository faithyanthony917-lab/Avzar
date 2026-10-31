import Link from 'next/link';
import { lpFont } from './fonts';
import { BrandLogo } from '@/components/BrandLogo';
import './app.css';

export default function NotFound() {
  return (
    <div className={`ap ap-auth ${lpFont.variable}`}>
      <header className="ap-authbar">
        <BrandLogo href="/" />
      </header>
      <main className="ap-card">
        <div className="ap-form">
          <h1>Page not found</h1>
          <p>This page does not exist or is not published.</p>
          <Link href="/" className="ap-btn ap-btn-link">Back to home</Link>
        </div>
      </main>
    </div>
  );
}
