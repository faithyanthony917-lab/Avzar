import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../http/errors.js';

const PAYSTACK = 'https://api.paystack.co';
const TIMEOUT_MS = 15_000;

/**
 * Billing provider interface (Paystack today). Tests inject a fake with the same shape:
 *   isConfigured(): boolean
 *   initialize({ email, amountMinor, currency, reference, callbackUrl, metadata }): Promise<{ authorizationUrl }>
 *   verify(reference): Promise<{ status, reference, currency, amountMinor }>
 *   listBanks(): Promise<Array<{ name, code }>>
 *   createSubaccount({ businessName, bankCode, accountNumber }): Promise<{ subaccountCode, accountName }>
 *   verifySignature(rawBody: Buffer, signature: string): boolean
 */
export function createBillingProvider(env) {
  const secret = env.BILLING_PAYSTACK_SECRET_KEY?.trim() || '';

  async function call(path, init) {
    const response = await fetch(PAYSTACK + path, {
      ...init,
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new AppError(502, 'billing_provider_error', 'The payment provider could not complete this request.');
    try { return JSON.parse(text); }
    catch { throw new AppError(502, 'billing_provider_error', 'The payment provider returned an unreadable response.'); }
  }

  return {
    isConfigured: () => secret.length > 0,
    async initialize({ email, amountMinor, currency, reference, callbackUrl, metadata, subaccount }) {
      const body = { email, amount: amountMinor, currency, reference, metadata };
      // A split payment: the money goes to the business's own subaccount, which also bears the provider's fee.
      if (subaccount) { body.subaccount = subaccount; body.bearer = 'subaccount'; }
      if (callbackUrl) body.callback_url = callbackUrl;
      const json = await call('/transaction/initialize', { method: 'POST', body: JSON.stringify(body) });
      const url = json?.data?.authorization_url;
      if (typeof url !== 'string' || !url) throw new AppError(502, 'billing_provider_error', 'The payment provider returned an unreadable response.');
      return { authorizationUrl: url };
    },
    async verify(reference) {
      const json = await call(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
      const data = json?.data ?? {};
      return { status: data.status, reference: data.reference, currency: data.currency, amountMinor: Number.isSafeInteger(data.amount) ? data.amount : null };
    },
    async listBanks() {
      const json = await call('/bank?country=nigeria&perPage=200', { method: 'GET' });
      const banks = Array.isArray(json?.data) ? json.data : [];
      return banks.filter((bank) => typeof bank?.name === 'string' && typeof bank?.code === 'string' && bank.active !== false)
        .map((bank) => ({ name: bank.name, code: bank.code }));
    },
    async createSubaccount({ businessName, bankCode, accountNumber }) {
      // percentage_charge 0: the platform keeps nothing from an invoice payment.
      const json = await call('/subaccount', { method: 'POST', body: JSON.stringify({ business_name: businessName, settlement_bank: bankCode, account_number: accountNumber, percentage_charge: 0 }) });
      const code = json?.data?.subaccount_code;
      if (typeof code !== 'string' || !code) throw new AppError(502, 'billing_provider_error', 'The payment provider returned an unreadable response.');
      return { subaccountCode: code, accountName: typeof json?.data?.account_name === 'string' ? json.data.account_name : null };
    },
    verifySignature(rawBody, signature) {
      if (!secret || typeof signature !== 'string' || !Buffer.isBuffer(rawBody)) return false;
      const expected = Buffer.from(createHmac('sha512', secret).update(rawBody).digest('hex'), 'ascii');
      const supplied = Buffer.from(signature.toLowerCase(), 'ascii');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
  };
}
