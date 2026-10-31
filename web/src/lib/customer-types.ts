/** Mirror Tailoring.Application.Customers DTOs. */
export type CustomerStatus = 'Active' | 'Inactive' | 'Merged';

export interface Customer {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  addressLine: string | null;
  city: string | null;
  notes: string | null;
  garmentPreferences: string | null;
  status: CustomerStatus;
  mergedIntoCustomerId: string | null;
  version: number;
  createdAtUtc: string;
}

export interface CustomerSummary {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: CustomerStatus;
  orderCount: number;
  createdAtUtc: string;
}

export interface DuplicateCandidate { id: string; fullName: string; email: string | null; phone: string | null; matchedOn: string }

export interface Communication {
  id: string;
  channel: string;
  direction: string;
  subject: string | null;
  body: string;
  recordedByUserId: string | null;
  createdAtUtc: string;
}

export interface Paged<T> { items: T[]; page: number; pageSize: number; totalCount: number }
