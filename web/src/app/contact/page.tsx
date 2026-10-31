import type { Metadata } from 'next';
import { InfoPage } from '@/components/site/InfoPage';
import { LEGAL } from '@/lib/legal';

export const metadata: Metadata = { title: 'Contact us · Avzar' };

export default function Contact() {
  return (
    <InfoPage>
      <h1>Contact us</h1>
      <p className="lp-lead">Questions, problems or feedback? Email us and a person will reply.</p>
      <p><a className="lp-btn" href={`mailto:${LEGAL.supportEmail}`}>{LEGAL.supportEmail}</a></p>
      <h2>To get help faster</h2>
      <ul>
        <li>Say which business and which page you were on.</li>
        <li>Describe what you expected and what happened instead.</li>
        <li>Add a screenshot if you can. Never send your password.</li>
      </ul>
      <p>You may also find your answer in the <a href="/help">help guides</a>.</p>
    </InfoPage>
  );
}
