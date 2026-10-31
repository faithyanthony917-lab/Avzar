import Link from 'next/link';
import '../../app/landing.css';

export function PublicFooter() {
  return (
    <footer className="lp-foot">
      <div className="wrap lp-foot-in">
        <div>
          <p className="lp-foot-brand">Avzar</p>
          <p className="lp-foot-note">Business tools for tailors and fashion brands.</p>
        </div>
        <nav aria-label="Footer" className="lp-foot-cols">
          <div><h2>Product</h2><Link href="/#features">Features</Link><Link href="/#get-the-app">Get the app</Link><Link href="/login">Sign in</Link></div>
          <div><h2>Support</h2><Link href="/help">Help guides</Link><Link href="/contact">Contact us</Link></div>
          <div><h2>Legal</h2><Link href="/terms">Terms</Link><Link href="/privacy">Privacy Policy</Link><Link href="/privacy#cookies">Cookies</Link></div>
        </nav>
      </div>
    </footer>
  );
}
