import * as SecureStore from 'expo-secure-store';
import type {
  ApiErrorPayload,
  Customer,
  CustomerSummary,
  MeasurementSet,
  MobileBusinessChoice,
  MobileTokens,
  PagedResult,
  ReportSummary,
} from '@/types/api';

const API_BASE_URL = (process.env.EXPO_PUBLIC_API_URL ?? 'https://avzar-api.onrender.com').replace(/\/$/, '');
const ACCESS_KEY = 'avzar.mobile.access';
const REFRESH_KEY = 'avzar.mobile.refresh';
const ACCESS_EXPIRY_KEY = 'avzar.mobile.access-expiry';

export class ApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class BusinessSelectionRequiredError extends Error {
  constructor(public readonly choices: MobileBusinessChoice[]) {
    super('Choose a business to continue.');
    this.name = 'BusinessSelectionRequiredError';
  }
}

async function readError(response: Response): Promise<ApiError> {
  const raw = await response.text();
  try {
    const payload = JSON.parse(raw) as ApiErrorPayload;
    return new ApiError(payload.detail ?? payload.message ?? payload.title ?? `Request failed (${response.status}).`, response.status, payload.code);
  } catch {
    return new ApiError(raw || `Request failed (${response.status}).`, response.status);
  }
}

async function storeTokens(tokens: MobileTokens): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken);
  await SecureStore.setItemAsync(ACCESS_EXPIRY_KEY, tokens.accessExpiresAtUtc);
}

async function clearTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
    SecureStore.deleteItemAsync(ACCESS_EXPIRY_KEY),
  ]);
}

async function refreshTokens(): Promise<string> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
  if (!refreshToken) throw new ApiError('Your session has expired. Sign in again.', 401);

  const response = await fetch(`${API_BASE_URL}/api/auth/token/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    await clearTokens();
    throw await readError(response);
  }

  const tokens = (await response.json()) as MobileTokens;
  await storeTokens(tokens);
  return tokens.accessToken;
}

async function accessToken(): Promise<string> {
  const token = await SecureStore.getItemAsync(ACCESS_KEY);
  if (!token) throw new ApiError('Sign in to continue.', 401);
  const rawExpiry = await SecureStore.getItemAsync(ACCESS_EXPIRY_KEY);
  const expiry = rawExpiry ? Date.parse(rawExpiry) : Number.NaN;
  if (!Number.isFinite(expiry) || expiry <= Date.now() + 60_000) return refreshTokens();
  return token;
}

export const BUSINESS_EVENTS_URL = `${API_BASE_URL}/hubs/business-events`;
export const taskPhotoFileUrl = (taskId: string, photoId: string) => `${API_BASE_URL}/api/my/tasks/${encodeURIComponent(taskId)}/photos/${encodeURIComponent(photoId)}/file/md`;

/** Current access token (refreshed first if it is about to expire), for the live-update connection. */
export function realtimeAccessToken(): Promise<string> {
  return accessToken();
}

async function request<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (auth) headers.set('Authorization', `Bearer ${await accessToken()}`);

  let response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (auth && response.status === 401) {
    const refreshed = await refreshTokens();
    headers.set('Authorization', `Bearer ${refreshed}`);
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  }
  if (!response.ok) throw await readError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  async signIn(email: string, password: string, businessId?: string): Promise<MobileTokens> {
    const response = await fetch(`${API_BASE_URL}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email: email.trim(), password, businessId: businessId ?? null, deviceName: 'Avzar Expo' }),
    });
    if (response.status === 409) {
      const payload = (await response.json()) as { code?: string; choices?: MobileBusinessChoice[] };
      if (payload.code === 'choose_business') throw new BusinessSelectionRequiredError(payload.choices ?? []);
    }
    if (!response.ok) throw await readError(response);
    const tokens = (await response.json()) as MobileTokens;
    await storeTokens(tokens);
    return tokens;
  },

  async signOut(): Promise<void> {
    const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
    if (refreshToken) {
      try {
        await fetch(`${API_BASE_URL}/api/auth/token/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // Local credentials are still cleared if revocation cannot reach the server.
      }
    }
    await clearTokens();
  },

  async currentUser(): Promise<MobileTokens['user']> {
    return request<MobileTokens['user']>('/api/auth/me');
  },

  async customers(search = ''): Promise<CustomerSummary[]> {
    const query = new URLSearchParams({ page: '1', pageSize: '50', sort: 'name' });
    if (search.trim()) query.set('search', search.trim());
    const result = await request<PagedResult<CustomerSummary> | CustomerSummary[]>(`/api/customers?${query.toString()}`);
    return Array.isArray(result) ? result : result.items ?? [];
  },

  customer(id: string): Promise<Customer> {
    return request<Customer>(`/api/customers/${encodeURIComponent(id)}`);
  },

  createCustomer(input: {
    fullName: string;
    email?: string;
    phone?: string;
    addressLine?: string;
    city?: string;
    garmentPreferences?: string;
    notes?: string;
  }): Promise<Customer> {
    return request<Customer>('/api/customers', { method: 'POST', body: JSON.stringify(input) });
  },

  measurements(customerId: string): Promise<MeasurementSet[]> {
    return request<MeasurementSet[]>(`/api/customers/${encodeURIComponent(customerId)}/measurements`);
  },

  async taskPhotos(taskId: string): Promise<Array<{ id: string; taskId: string; caption: string | null; uploadedAtUtc: string; fileName: string }>> {
    const result = await request<{ items?: Array<{ id: string; taskId: string; caption: string | null; uploadedAtUtc: string; fileName: string }> }>(`/api/my/tasks/${encodeURIComponent(taskId)}/photos`);
    return result.items ?? [];
  },

  async uploadTaskPhoto(taskId: string, uri: string, fileName: string, mimeType: string, caption?: string): Promise<unknown> {
    const form = new FormData();
    form.append('file', { uri, name: fileName, type: mimeType } as unknown as Blob);
    if (caption?.trim()) form.append('caption', caption.trim());
    const headers = new Headers({ Accept: 'application/json', Authorization: `Bearer ${await accessToken()}` });
    const path = `/api/my/tasks/${encodeURIComponent(taskId)}/photos`;
    let response = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', headers, body: form });
    if (response.status === 401) {
      headers.set('Authorization', `Bearer ${await refreshTokens()}`);
      response = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', headers, body: form });
    }
    if (!response.ok) throw await readError(response);
    return response.json();
  },

  reportTaskIssue(taskId: string, type: 'MissingMaterials' | 'Defect' | 'Clarification' | 'Other', description: string): Promise<unknown> {
    return request<unknown>(`/api/my/tasks/${encodeURIComponent(taskId)}/issues`, {
      method: 'POST', body: JSON.stringify({ type, description: description.trim() }),
    });
  },

  taskAction(taskId: string, action: 'start' | 'pause' | 'resume' | 'complete', note?: string): Promise<unknown> {
    const body = action === 'pause' ? { note } : action === 'complete' ? { notes: note, completedChecks: [] as string[] } : {};
    return request<unknown>(`/api/my/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
  },

  reportsSummary(from: string, to: string): Promise<ReportSummary> {
    return request<ReportSummary>(`/api/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  },

  async myTasks(): Promise<Array<{ id: string; orderId?: string; orderNumber?: string; garmentName?: string; title: string; stageName?: string; status: string; deadlineUtc?: string | null; instructions?: string | null; blockedReason?: string | null }>> {
    const result = await request<unknown>('/api/my/tasks?page=1&pageSize=100&show=open');
    if (Array.isArray(result)) return result as Array<{ id: string; orderId?: string; orderNumber?: string; garmentName?: string; title: string; stageName?: string; status: string; deadlineUtc?: string | null; instructions?: string | null; blockedReason?: string | null }> ;
    if (result && typeof result === 'object' && 'items' in result && Array.isArray((result as { items: unknown }).items)) {
      return (result as { items: Array<{ id: string; orderId?: string; orderNumber?: string; garmentName?: string; title: string; stageName?: string; status: string; deadlineUtc?: string | null; instructions?: string | null; blockedReason?: string | null }> }).items;
    }
    return [];
  },
};

export async function hasStoredSession(): Promise<boolean> {
  return Boolean(await SecureStore.getItemAsync(ACCESS_KEY));
}
