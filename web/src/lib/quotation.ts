/** View-model helpers for quotations: the staff panel on an order and the customer portal section. Pure, so they are unit-tested. */
export type QuotationState = 'NotApplicable' | 'NotSent' | 'Sent' | 'Approved' | 'Declined';

export type QuotationStatus = {
  state: QuotationState;
  orderStatus: string;
  sentAtUtc: string | null;
  sendCount: number;
  decidedAtUtc: string | null;
  customerNote: string | null;
  canSend: boolean;
  readyToConfirm: boolean;
};

export type PortalQuotation = {
  orderId: string;
  quotationId: string;
  orderNumber: string;
  promisedDate: string;
  currencyCode: string;
  subtotal: number;
  discount: number;
  total: number;
  sentAtUtc: string | null;
  decision: 'Approved' | 'Declined' | null;
  decidedAtUtc: string | null;
  lines: { name: string; quantity: number; unitPrice: number; lineTotal: number }[];
};

export const NOTE_MAX = 500;

export function quotationHeadline(status: QuotationStatus): string {
  switch (status.state) {
    case 'Approved': return status.readyToConfirm ? 'Approved by the customer. Ready to convert to an order.' : 'Approved by the customer.';
    case 'Declined': return 'Declined by the customer. Edit the order and issue a new quotation to ask again.';
    case 'Sent': return 'Sent to the customer. Waiting for their answer.';
    case 'NotSent': return 'Not sent to the customer yet.';
    default: return 'No quotation has been issued for this order.';
  }
}

export function sendLabel(status: QuotationStatus): string {
  return status.sendCount > 0 ? 'Resend to customer' : 'Send to customer';
}

export function noteProblem(note: string): string | null {
  return note.trim().length > NOTE_MAX ? `Keep your message under ${NOTE_MAX} characters.` : null;
}

const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Reads the portal response defensively: anything malformed is dropped rather than rendered. */
export function normalizePortalQuotations(payload: unknown): PortalQuotation[] {
  const list = (payload as { quotations?: unknown } | null)?.quotations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw): PortalQuotation[] => {
    const q = raw as Record<string, unknown> | null;
    if (!q || typeof q !== 'object' || !asString(q.orderId) || !asString(q.quotationId)) return [];
    const decision = q.decision === 'Approved' || q.decision === 'Declined' ? q.decision : null;
    const lines = Array.isArray(q.lines) ? q.lines : [];
    return [{
      orderId: asString(q.orderId), quotationId: asString(q.quotationId), orderNumber: asString(q.orderNumber), promisedDate: asString(q.promisedDate),
      currencyCode: asString(q.currencyCode), subtotal: asNumber(q.subtotal), discount: asNumber(q.discount), total: asNumber(q.total),
      sentAtUtc: typeof q.sentAtUtc === 'string' ? q.sentAtUtc : null, decision, decidedAtUtc: typeof q.decidedAtUtc === 'string' ? q.decidedAtUtc : null,
      lines: lines.map((l) => {
        const line = (l ?? {}) as Record<string, unknown>;
        return { name: asString(line.name), quantity: asNumber(line.quantity), unitPrice: asNumber(line.unitPrice), lineTotal: asNumber(line.lineTotal) };
      }),
    }];
  });
}

export function decisionMessage(decision: 'Approved' | 'Declined', orderNumber: string): string {
  return decision === 'Approved'
    ? `You approved quotation ${orderNumber}. The business will confirm your order.`
    : `You declined quotation ${orderNumber}. The business has been told.`;
}
