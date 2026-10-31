export type MobileUser = {
  id?: string;
  fullName: string;
  email: string;
  businessName: string;
  currencyCode: string;
};

export type MobileBusinessChoice = {
  businessId: string;
  businessName: string;
};

export type MobileTokens = {
  accessToken: string;
  accessExpiresAtUtc: string;
  refreshToken: string;
  refreshExpiresAtUtc: string;
  user: MobileUser;
};

export type PagedResult<T> = {
  items: T[];
  totalCount?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
};

export type CustomerSummary = {
  id: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  status: string;
  orderCount: number;
  createdAtUtc: string;
};

export type Customer = {
  id: string;
  fullName: string;
  email?: string | null;
  phone?: string | null;
  addressLine?: string | null;
  city?: string | null;
  notes?: string | null;
  garmentPreferences?: string | null;
  status: string;
  version: number;
  createdAtUtc: string;
};

export type MeasurementValue = {
  key: string;
  label: string;
  unit: string;
  value: number;
};

export type MeasurementSet = {
  id: string;
  customerId: string;
  templateId: string;
  templateName: string;
  label: string;
  currentRevision: number;
  values: MeasurementValue[];
  updatedAtUtc: string;
};

export type ApiErrorPayload = {
  code?: string;
  title?: string;
  detail?: string;
  message?: string;
};

// Subset of GET /api/reports/summary (needs reports.view) that the Home screen shows.
export type ReportSummary = {
  from: string; to: string; currencyCode: string;
  ordersCreated: number; ordersDelivered: number; verifiedRevenue: number;
  openTasks: number; overdueTasks: number; activeCustomers: number;
};
