import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicFooter } from '@/components/site/PublicFooter';
import { PublicHeader } from '@/components/site/PublicHeader';
import { lpFont } from './fonts';
import StoreButton from './store-button';
import './landing.css';

export const metadata: Metadata = {
  title: 'Avzar: run your tailoring business from one place',
  description: 'Orders, customers, workers, stock, money and your own website, built for tailors and fashion brands.',
};

const features = [
  { t: 'Orders', d: 'Quote, confirm and track every order from the first conversation to delivery.' },
  { t: 'Customers', d: 'Keep every customer and their orders together, so nothing lives in a notebook.' },
  { t: 'Workers and tasks', d: 'Give work to your tailors and see what is due and what is late.' },
  { t: 'Inventory', d: 'Know how much fabric and how many supplies you have before you promise a date.' },
  { t: 'Finance', d: 'See money in and money out for the whole business or for one location.' },
  { t: 'Reports', d: 'Check how the business is doing without building a spreadsheet.' },
];

const sample = [
  { c: 'Adaeze O.', i: 'Two-piece suit', s: 'In production' },
  { c: 'Tunde A.', i: 'Agbada set', s: 'Quoted' },
  { c: 'Miriam K.', i: 'Wedding gown', s: 'Ready' },
  { c: 'Chuka E.', i: 'Shirt, 3 pieces', s: 'Delivered' },
];

export default function Home() {
  return (
    <div className={`lp ${lpFont.variable}`}>
      <a href="#main" className="skip">Skip to content</a>
      <PublicHeader />

      <main id="main">
        <section className="wrap lp-hero">
          <div className="lp-hero-text">
            <h1>Run your tailoring business from one place.</h1>
            <p className="lp-lead">
              Avzar gives tailors and fashion brands one place for orders, customers, workers, stock and money, plus a website of your own.
            </p>
            <div className="lp-actions">
              <Link href="/register" className="lp-btn">Create a business account</Link>
              <Link href="/dashboard" className="lp-btn lp-btn-alt">Open the web app</Link>
            </div>
          </div>
          <div className="lp-panel" aria-hidden="true">
            <div className="lp-panel-head"><strong>Orders</strong><span>This week</span></div>
            <ul>
              {sample.map((r) => (
                <li key={r.c}>
                  <div><strong>{r.c}</strong><span>{r.i}</span></div>
                  <em>{r.s}</em>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <div className="lp-tape-wrap" aria-hidden="true">
          <div className="lp-tape">
            {Array.from({ length: 31 }, (_, i) => <span key={i}>{i}</span>)}
          </div>
        </div>

        <section id="features" className="wrap lp-sec">
          <h2>Everything the workshop needs</h2>
          <ul className="lp-list">
            {features.map((f) => (
              <li key={f.t}>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="storefront" className="lp-shop">
          <div className="wrap">
            <h2>Your shop, online</h2>
            <p>
              Build a storefront for your brand, preview it, and publish it at your own address. Customers can find your work and send you an inquiry.
            </p>
          </div>
        </section>

        <section id="get-the-app" className="wrap lp-sec">
          <h2>Use Avzar on any device</h2>
          <ul className="lp-list lp-apps">
            <li>
              <h3>Web app</h3>
              <p>Open Avzar in the browser on your phone, tablet or computer.</p>
              <div className="lp-actions">
                <Link href="/dashboard" className="lp-btn lp-app-btn">Open the web app</Link>
              </div>
            </li>
            <li>
              <h3>Android</h3>
              <p>The Android app is on its way.</p>
              <StoreButton eyebrow="Get it on" store="Google Play" message="The Android app is coming soon. For now, use the web app." />
            </li>
            <li>
              <h3>iPhone and iPad</h3>
              <p>The iOS app is on its way.</p>
              <StoreButton eyebrow="Download on the" store="App Store" message="The iOS app is coming soon. For now, use the web app." />
            </li>
          </ul>
        </section>

        <section className="lp-cta">
          <div className="wrap">
            <h2>Set up your business in a few minutes.</h2>
            <div className="lp-actions">
              <Link href="/register" className="lp-btn">Create a business account</Link>
            </div>
          </div>
        </section>
      </main>

      <PublicFooter />
    </div>
  );
}
