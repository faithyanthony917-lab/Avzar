/** Mirror Tailoring.Application.Staff / Roles / Locations DTOs. */
export interface StaffMember {
  membershipId: string;
  userId: string;
  displayName: string;
  email: string;
  isOwner: boolean;
  status: 'Active' | 'Deactivated';
  roleIds: string[];
  locationIds: string[];
}
export interface Role { id: string; name: string; isSystem: boolean; permissions: string[] }
export interface Location { id: string; name: string; address: string | null; isActive: boolean }
export interface Invitation { id: string; email: string; expiresAtUtc: string }
