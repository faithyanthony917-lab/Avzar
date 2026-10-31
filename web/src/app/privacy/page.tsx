import type { Metadata } from 'next';
import { InfoPage } from '@/components/site/InfoPage';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Privacy Policy · Avzar' };

// DRAFT: have a lawyer review this text before launch (data protection law depends on where you and your customers are).
export default function Privacy() {
  return (
    <InfoPage>
      <h1>Privacy Policy</h1>
      <p className="lp-meta">Effective {LEGAL.effectiveDate}</p>
      <p>This policy explains what personal information {LEGAL.operator} collects through {LEGAL.product}, why, and what you can do about it.</p>

      <h2>Two roles</h2>
      <p>For your own account details we decide how the information is used. For the customer records and other business data you enter, you decide why it is collected and we only process it for you, to run the service.</p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account details:</strong> your name, email, password (stored in hashed form), business name, time zone and currency.</li>
        <li><strong>Business data you enter:</strong> customers, orders, invoices, payments, expenses, inventory, staff, designs, images and storefront content.</li>
        <li><strong>Payments:</strong> subscription payments are handled by our payment provider. We keep the payment reference and status, not your card details.</li>
        <li><strong>Technical and security logs:</strong> such as IP address, browser type, and errors, to keep the service secure and working.</li>
        <li><strong>Messages:</strong> emails you send us and the service emails we send you.</li>
      </ul>

      <h2>How we use it</h2>
      <p>To provide and secure the service, to sign you in, to send invitations, receipts and notices, to take payment, to give support, and to fix problems. We do not sell personal information.</p>

      <h2>Who we share it with</h2>
      <p>Only the providers that help us run {LEGAL.product}: our hosting provider, our email delivery provider, our payment provider, and a bot-protection service on public forms where it is enabled. They may process data only to provide their service to us. We may also disclose information when the law requires it.</p>

      <h2 id="cookies">Cookies</h2>
      <p>{LEGAL.product} uses only the cookies it needs to work: a session cookie that keeps you signed in, and a security cookie that protects forms from forgery. These are essential, so we do not ask for consent for them. We do not use advertising or analytics cookies. The optional storefront page-view counts described under &ldquo;Public storefronts&rdquo; below use no cookies. You can clear cookies in your browser at any time, which signs you out.</p>

      <h3>Public storefronts</h3>
      <p>Storefronts that businesses publish with {LEGAL.product} show a &ldquo;Privacy choices&rdquo; control. A business can switch on simple page-view analytics for its storefront; they are off by default, and nothing is counted unless the business has switched them on and you have accepted them.</p>
      <p>When you accept, your browser tells the storefront which page you opened, and the storefront adds one to a daily count for that page. We do not set a cookie, and we do not store your IP address, browser details, referrer or any identifier for these counts, so a count cannot be traced back to you. The business sees totals per day and per page, and how many visitors accepted or rejected analytics.</p>
      <p>We also keep a record of each privacy choice (the version of the notice, whether it was accepted or rejected, the time and the storefront), without any detail about who made it. Your choice is saved in your own browser for that storefront, and you can change it at any time from the same control. If you reject or withdraw, your browser stops sending page views. Because counts are anonymous, a count already made cannot be removed. Clearing your browser storage resets your choice, and a saved choice expires after 180 days, when you are asked again.</p>
      <h2>How long we keep it</h2>
      <p>We keep your data while your account is open. When you ask us to delete your account, we delete its business data within a reasonable period, except where we must keep records, for example for tax or legal reasons, or in short-lived backups.</p>

      <h2>Your choices and rights</h2>
      <p>You can see and edit most of your information in the app, and export your customers and other data. You can ask us to correct, export or delete personal information about you, and to stop certain uses of it. If you are a customer of one of our users, contact that business first, because it decides how your information is used. Depending on where you live you may also complain to your data protection regulator.</p>

      <h2>Security</h2>
      <p>We use access controls, encrypted connections and separation between businesses&rsquo; data. No system is perfectly secure, so please use a strong, unique password. If a breach affects you we will tell you as the law requires.</p>

      <h2>Where data is stored</h2>
      <p>Our providers may store and process data in other countries. We choose providers that protect it to a reasonable standard.</p>

      <h2>Children</h2>
      <p>{LEGAL.product} is for businesses and is not meant for children under 16.</p>

      <h2>Changes</h2>
      <p>We may update this policy. If a change is important we will notify you by email or in the app.</p>

      <h2>Contact</h2>
      <p>Privacy questions or requests: <a href={`mailto:${LEGAL.supportEmail}`}>{LEGAL.supportEmail}</a>.</p>
    </InfoPage>
  );
}
