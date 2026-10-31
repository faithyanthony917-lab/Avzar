/** Mirrors Tailoring.Application.Auth.CurrentUserDto. */
export interface CurrentUser {
  userId: string;
  email: string;
  fullName: string;
  businessId: string;
  businessName: string;
  timeZoneId: string;
  currencyCode: string;
  isOwner: boolean;
  permissions: string[];
}

export interface BusinessChoice { businessId: string; businessName: string }

/** One active membership returned by GET /api/auth/businesses. */
export interface BusinessMembership { businessId: string; businessName: string; isOwner: boolean; isCurrent: boolean }
