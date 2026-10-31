import { AppError } from '../http/errors.js';

/** The configured platform administrators (PLATFORM_ADMIN_EMAILS, comma separated). */
export function platformEmails(env) {
  return String(env?.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

/** Throws 403 unless the signed-in email is on the configured allowlist. Every platform-admin service starts with this. */
export function requirePlatformAdmin(email, configuredEmails) {
  const allowed = new Set(configuredEmails.map((value) => value.trim().toLowerCase()).filter(Boolean));
  if (!email || !allowed.has(email.trim().toLowerCase())) throw AppError.forbidden('platform_admin_required', 'Platform administrator access is required.');
}
