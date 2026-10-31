/** Mirrors GET/PUT /api/account/profile in backend-node/src/auth/accountRoutes.js. */
export interface Profile { fullName: string; email: string; phone: string | null }
export interface ProfileBody { fullName: string; phone: string | null }

export const PROFILE_NAME_MIN = 2;
export const PROFILE_NAME_MAX = 120;
export const PROFILE_PHONE_MAX = 40;
/** Same pattern as the API: digits, spaces, + ( ) - . and at least four characters. */
const PHONE_PATTERN = /^[+(0-9][0-9 ()\-.]{3,39}$/;

export interface ProfileErrors { fullName?: string; phone?: string }
export type ProfileCheck = { ok: true; body: ProfileBody } | { ok: false; errors: ProfileErrors };

export function validateProfile(input: { fullName: string; phone: string }): ProfileCheck {
  const fullName = input.fullName.trim();
  const phone = input.phone.trim();
  const errors: ProfileErrors = {};
  if (fullName.length < PROFILE_NAME_MIN) errors.fullName = `Enter your name (at least ${PROFILE_NAME_MIN} characters).`;
  else if (fullName.length > PROFILE_NAME_MAX) errors.fullName = `Keep your name to ${PROFILE_NAME_MAX} characters or fewer.`;
  if (phone && phone.length > PROFILE_PHONE_MAX) errors.phone = `Keep the number to ${PROFILE_PHONE_MAX} characters or fewer.`;
  else if (phone && !PHONE_PATTERN.test(phone)) errors.phone = 'Use digits, spaces, + ( ) - or . for the phone number.';
  if (errors.fullName || errors.phone) return { ok: false, errors };
  return { ok: true, body: { fullName, phone: phone || null } };
}

/** True when saving would change something, so an untouched form does not send a request. */
export function profileChanged(original: Profile, body: ProfileBody): boolean {
  return original.fullName !== body.fullName || (original.phone ?? null) !== body.phone;
}
