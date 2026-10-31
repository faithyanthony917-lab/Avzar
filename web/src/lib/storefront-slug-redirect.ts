export function canonicalStorefrontUrl(
  requestUrl: string | URL,
  requestedSlug: string,
  currentSlug: string,
  baseDomain: string,
): string | null {
  if (requestedSlug === currentSlug) return null;
  const url = new URL(requestUrl);
  const domain = baseDomain.toLowerCase();

  if (url.hostname === `${requestedSlug}.${domain}`) {
    url.hostname = `${currentSlug}.${domain}`;
    return url.toString();
  }

  const sharedPrefix = `/sites/${requestedSlug}`;
  if (url.hostname !== domain || (url.pathname !== sharedPrefix && !url.pathname.startsWith(`${sharedPrefix}/`))) return null;
  url.pathname = `/sites/${currentSlug}${url.pathname.slice(sharedPrefix.length)}`;
  return url.toString();
}