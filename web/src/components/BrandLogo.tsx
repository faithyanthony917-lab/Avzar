import Link from 'next/link';

/**
 * The Avzar mark beside the wordmark. The image is decorative (the visible text names the link).
 * Layout uses style attributes, which the site's Content-Security-Policy allows, so no stylesheet changes are needed.
 */
export function BrandLogo({ href, className = 'ap-logo', size = 28, tagline }: { href: string; className?: string; size?: number; tagline?: string }) {
  return (
    <Link href={href} className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/icons/icon-192.png" alt="" width={size} height={size} style={{ borderRadius: 8, flex: 'none' }} />
      <span>Avzar</span>
      {tagline && <small className="ap-logo-tag">{tagline}</small>}
    </Link>
  );
}
