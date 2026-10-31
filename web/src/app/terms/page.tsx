import type { Metadata } from 'next';
import Link from 'next/link';
import { InfoPage } from '@/components/site/InfoPage';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Terms of Service · Avzar' };

// DRAFT: have a lawyer review this text before launch.
export default function Terms() {
  return (
    <InfoPage>
      <h1>Terms of Service</h1>
      <p className="lp-meta">Effective {LEGAL.effectiveDate}</p>
      <p>These terms are the agreement between {LEGAL.operator} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) and the person or business that uses {LEGAL.product} (&ldquo;you&rdquo;). By creating an account or using {LEGAL.product} you agree to them.</p>

      <h2>1. Your account</h2>
      <p>You must give accurate information and keep your password safe. You are responsible for what happens under your account, including the actions of staff you invite. Tell us straight away if you think someone else has access.</p>

      <h2>2. Your business data</h2>
      <p>You own the data you put into {LEGAL.product}, such as customers, orders, designs, images and storefront content. You give us permission to store and process it only to run the service for you. You promise you have the right to use that data, including the right to hold your customers&rsquo; information.</p>

      <h2>3. Acceptable use</h2>
      <p>Do not use {LEGAL.product} to break the law, to sell illegal goods, to harass or defraud people, to upload harmful or infringing content, or to attack or overload the service. We may suspend an account that does this.</p>

      <h2>4. Plans and payment</h2>
      <p>{LEGAL.product} has a Free plan and paid plans. Each plan has limits, such as the number of staff, customers and orders, and some features are only on higher plans. Paid plans are billed in advance, monthly or annually where offered, and payments are processed by our payment provider. Fees you have paid are not refundable unless the law says otherwise. We will tell you before we change prices, and a change applies from your next billing period.</p>

      <h2>5. Storefronts and your customers</h2>
      <p>If you publish a storefront, you are responsible for its content and for how you deal with your own customers, including orders, prices and refunds. {LEGAL.product} is a tool for your business and is not a party to your sales.</p>

      <h2>6. Availability and changes</h2>
      <p>We work to keep {LEGAL.product} running but cannot promise it will never be interrupted or error-free. We may improve, change or remove features. We will try to give notice of major changes.</p>

      <h2>7. Ending your account</h2>
      <p>You can stop using {LEGAL.product} at any time and ask us to delete your account. Before you leave, export the data you want to keep. We may suspend or end accounts that break these terms or are unpaid. After an account is closed we delete its data as described in the <Link href="/privacy">Privacy Policy</Link>.</p>

      <h2>8. Our responsibility</h2>
      <p>{LEGAL.product} is provided &ldquo;as is&rdquo;. To the extent the law allows, we are not liable for lost profits, lost data or indirect losses, and our total liability for any claim is limited to the amount you paid us in the 12 months before it. Nothing in these terms limits liability that cannot be limited by law.</p>

      <h2>9. Changes to these terms</h2>
      <p>We may update these terms. If a change is important we will notify you by email or in the app. Using {LEGAL.product} after a change means you accept it.</p>

      <h2>10. Governing law</h2>
      <p>These terms are governed by the laws of {LEGAL.country}, and its courts handle disputes, unless local consumer law says otherwise.</p>

      <h2>11. Contact</h2>
      <p>Questions about these terms: <a href={`mailto:${LEGAL.supportEmail}`}>{LEGAL.supportEmail}</a>.</p>
    </InfoPage>
  );
}
