import Link from 'next/link';
import { mediaUrl } from '@/lib/api';
import { fontsHref, themeStyle } from '@/lib/theme';
import { pagePath } from '@/lib/links';
import type { Site } from '@/lib/types';
import StorefrontAnalyticsTracker from '@/components/site/StorefrontAnalyticsTracker';
import StorefrontPrivacyChoices from '@/components/site/StorefrontPrivacyChoices';

const SOCIAL: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', x: 'X', youtube: 'YouTube', pinterest: 'Pinterest', whatsapp: 'WhatsApp', linkedin: 'LinkedIn' };

export default function SiteShell({ site, base, children }: { site: Site; base: string; children: React.ReactNode }) {
  const doc = site.document;
  const b = doc.branding;
  const fonts = fontsHref(site.theme);
  const logo = mediaUrl(b.logoMediaId, 'md');
  const nav = doc.navigation.filter((n) => n.visible).map((n) => ({ ...n, page: doc.pages.find((p) => p.id === n.pageId) })).filter((n) => n.page);

  return (
    <div className="site" style={themeStyle(site.theme)} data-template={site.templateKey}>
      {fonts ? <link rel="stylesheet" href={fonts} precedence="default" /> : null}
      <a className="skip" href="#main">Skip to content</a>
      {site.isPreview ? <div className="preview-bar" role="status">{site.isSample ? 'Sample of this template with your shop name. It is not your draft. Visitors cannot see this.' : 'Preview of your draft. Visitors cannot see this.'}</div> : null}
      <header className={`hdr logo-${b.logoPlacement}`}>
        <div className="wrap hdr-in">
          <Link href={base || '/'} className="brand" aria-label={`${site.name} home`}>
            {logo ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={logo} alt="" width={b.logoWidth} style={{ width: b.logoWidth, height: 'auto' }} /> : null}
            {!logo ? <span className="brand-name">{site.name}</span> : null}
          </Link>
          {b.tagline ? <span className="tagline">{b.tagline}</span> : null}
          <nav aria-label="Main">
            <ul role="list">{nav.map((n) => <li key={n.pageId}><Link href={pagePath(base, n.page!)}>{n.label}</Link></li>)}</ul>
          </nav>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="ftr">
        <div className="wrap">
          {b.footerText ? <p>{b.footerText}</p> : null}
          {b.socialLinks.length > 0 ? (
            <ul className="social" role="list" aria-label="Social media">
              {b.socialLinks.map((l) => <li key={l.network}><a href={l.url} target="_blank" rel="noopener noreferrer">{SOCIAL[l.network] ?? l.network}</a></li>)}
            </ul>
          ) : null}
          <p className="small">© {new Date().getFullYear()} {site.businessName}</p>
        </div>
      </footer>
      {!site.isPreview ? <StorefrontPrivacyChoices siteSlug={site.slug} analyticsEnabled={site.analyticsEnabled === true} /> : null}
      {!site.isPreview ? <StorefrontAnalyticsTracker siteSlug={site.slug} analyticsEnabled={site.analyticsEnabled === true} /> : null}
    </div>
  );
}
