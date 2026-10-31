export type BillingPeriod = 'monthly' | 'annual';

export function priceForPeriod(plan: { monthlyPrice: number; annualPrice: number | null }, period: BillingPeriod): number | null {
  const value = period === 'annual' ? plan.annualPrice : plan.monthlyPrice;
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

export function canStartCheckout(price: number | null, busy: boolean): boolean {
  return !busy && price !== null && Number.isFinite(price) && price > 0;
}

export type SubscriptionView = {
  planCode: string;
  billingPeriod?: BillingPeriod | null;
  status: string;
  trialEndsAtUtc: string | null;
  graceEndsAtUtc: string | null;
  suspendedPlanCode: string | null;
  pendingPlanCode: string | null;
  pendingPlanName: string | null;
  currentPeriodEndUtc: string | null;
};

export type PlanAction = 'current' | 'subscribe' | 'renew' | 'switch_to_annual' | 'monthly_after_annual' | 'upgrade' | 'downgrade' | 'unavailable';

/** Optional period context for planAction. Without it (or when the current period is unknown) the same plan is simply "renew". */
export type PlanActionPeriods = { selectedPeriod?: BillingPeriod; currentPeriod?: BillingPeriod | null };

/**
 * What a paid plan card offers, given the subscription. It mirrors the server rules (subscriptionBillingService.createCheckout):
 * plans are ordered by their MONTHLY list price whichever period is selected, so changing the period never turns an upgrade into a
 * downgrade. A higher-priced plan starts immediately through checkout, a lower-priced one is scheduled for the period end, and for the plan
 * you already pay for the period matters: the same period renews, monthly -> annual is a switch (the remaining paid time is kept) and
 * annual -> monthly is refused while the annual period runs, because it would only queue a month behind the remaining year.
 */
export function planAction(
  current: Pick<SubscriptionView, 'planCode' | 'status'>,
  plan: { code: string; monthlyPrice: number },
  currentMonthlyPrice: number | null,
  periods: PlanActionPeriods = {},
): PlanAction {
  if (current.status !== 'Active' || current.planCode === 'free') return 'subscribe';
  if (plan.code === current.planCode) {
    const { selectedPeriod, currentPeriod } = periods;
    if (!selectedPeriod || !currentPeriod || selectedPeriod === currentPeriod) return 'renew';
    return selectedPeriod === 'annual' ? 'switch_to_annual' : 'monthly_after_annual';
  }
  if (currentMonthlyPrice === null) return 'unavailable';
  if (plan.monthlyPrice > currentMonthlyPrice) return 'upgrade';
  if (plan.monthlyPrice < currentMonthlyPrice) return 'downgrade';
  return 'unavailable';
}

/** True when the action goes through checkout (as opposed to being scheduled for the period end or not offered). */
export function actionStartsCheckout(action: PlanAction): boolean {
  return action === 'subscribe' || action === 'renew' || action === 'upgrade' || action === 'switch_to_annual';
}

/** One sentence under a plan card explaining what the chosen action does to the paid time. null when there is nothing to add. */
export function planActionNote(action: PlanAction, currentPeriodEndUtc: string | null, formatDate: (iso: string) => string): string | null {
  const until = currentPeriodEndUtc ? formatDate(currentPeriodEndUtc) : null;
  switch (action) {
    case 'upgrade': return 'Starts now. The unused part of your current payment is credited at checkout.';
    case 'switch_to_annual': return until
      ? `Your paid time until ${until} is kept. The annual year starts after it, so nothing is lost.`
      : 'Your remaining paid time is kept. The annual year starts after it.';
    case 'monthly_after_annual': return until
      ? `You are paid on annual billing until ${until}. Choose monthly billing when it renews.`
      : 'You are paid on annual billing. Choose monthly billing when it renews.';
    case 'renew': return until ? `Adds to your paid time. It now runs until ${until}.` : null;
    default: return null;
  }
}

export type Notice = { tone: 'info' | 'warn'; text: string };

/** Plain-language status messages. None of them implies that data is deleted or locked, because it is not. */
export function lifecycleNotices(current: SubscriptionView, formatDate: (iso: string) => string): Notice[] {
  const notices: Notice[] = [];
  if (current.status === 'Trialing' && current.trialEndsAtUtc) {
    notices.push({ tone: 'info', text: `Your free trial ends on ${formatDate(current.trialEndsAtUtc)}. Subscribe before then to keep the plan; otherwise you move to Free and nothing is deleted.` });
  }
  if (current.status === 'PastDue' && current.graceEndsAtUtc) {
    notices.push({ tone: 'warn', text: `Your renewal payment is overdue. Paid features stay available until ${formatDate(current.graceEndsAtUtc)}. Pay before then to avoid suspension.` });
  }
  if (current.status === 'Expired') {
    notices.push({ tone: 'warn', text: 'Your subscription is suspended and Free-plan limits apply. All your data is kept and stays accessible. Subscribe again to restore your plan.' });
  }
  if (current.pendingPlanName && current.currentPeriodEndUtc && current.status === 'Active') {
    notices.push({ tone: 'info', text: `You will move to ${current.pendingPlanName} on ${formatDate(current.currentPeriodEndUtc)}. Until then you keep your current plan.` });
  }
  return notices;
}

export function statusLabel(status: string): string {
  if (status === 'PastDue') return 'Payment overdue';
  if (status === 'Expired') return 'Suspended';
  if (status === 'Trialing') return 'Trial';
  return status;
}

/** After Paystack sends the customer back, the plan only changes once the server has verified the webhook, so the page re-checks a few times. */
export const CHECKOUT_RETURN_POLLS = 5;
export const CHECKOUT_RETURN_INTERVAL_MS = 3000;

/**
 * True when the URL carries a Paystack return reference that this app issued (createCheckout makes "avz_" + 32 hex characters).
 * The value is never displayed or sent anywhere; it only tells the page that the customer is coming back from checkout.
 */
export function isCheckoutReturn(params: Record<string, string | string[] | undefined>): boolean {
  const raw = params.reference ?? params.trxref;
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return !!value && /^avz_[0-9a-f]{32}$/.test(value);
}

/** What identifies the subscription on screen; a change means the server applied a payment or a scheduled change. */
export function subscriptionSignature(current: Pick<SubscriptionView, 'planCode' | 'status' | 'billingPeriod' | 'currentPeriodEndUtc'>): string {
  return [current.planCode, current.status, current.billingPeriod ?? '', current.currentPeriodEndUtc ?? ''].join('|');
}

export type CheckoutReturnState = 'none' | 'checking' | 'updated' | 'delayed';

/**
 * The message state after returning from checkout. "updated" is claimed only when the subscription shown really differs from the one
 * first shown on this visit; otherwise the page says it is checking, and after the last re-check that the confirmation may be delayed.
 */
export function checkoutReturnState(returned: boolean, changed: boolean, polls: number): CheckoutReturnState {
  if (!returned) return 'none';
  if (changed) return 'updated';
  return polls < CHECKOUT_RETURN_POLLS ? 'checking' : 'delayed';
}

export function checkoutReturnMessage(state: CheckoutReturnState): string | null {
  switch (state) {
    case 'checking': return 'Back from Paystack. The plan below updates as soon as the provider confirms your payment.';
    case 'updated': return 'Your subscription has been updated.';
    case 'delayed': return 'Paystack has not confirmed the payment yet. If the plan below has not changed, reload this page in a minute. Nothing changes until the payment is verified.';
    default: return null;
  }
}
