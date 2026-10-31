'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import { actionStartsCheckout, canStartCheckout, CHECKOUT_RETURN_INTERVAL_MS, checkoutReturnMessage, checkoutReturnState, lifecycleNotices, planAction, planActionNote, priceForPeriod, statusLabel, subscriptionSignature, type BillingPeriod, type PlanAction } from '@/lib/billing-view-model';

type Plan = { code: string; name: string; description: string | null; currencyCode: string; monthlyPrice: number; annualPrice: number | null; entitlements: Record<string, string> };
type Catalog = { plans: Plan[] };
type Entitlements = {
  planCode: string; planName: string; status: string; billingPeriod?: BillingPeriod | null;
  currentPeriodEndUtc: string | null; trialEndsAtUtc: string | null; graceEndsAtUtc: string | null; suspendedAtUtc: string | null;
  suspendedPlanCode: string | null; pendingPlanCode: string | null; pendingPlanName: string | null; trialDays: number; canStartTrial: boolean;
  items: { key: string; value: string; description: string; used: number | null; overLimit?: boolean }[];
};
type Checkout = { authorizationUrl: string; reference: string; amount: number; creditAmount: number; currencyCode: string; expiresAtUtc: string };

const money = (n: number, c: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency: c, maximumFractionDigits: 2 }).format(n);
// Fixed locale and UTC so the server render and the browser render print the same text.
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
const BUTTON_LABEL: Record<PlanAction, string> = {
  current: 'Current plan', subscribe: 'Subscribe to', renew: 'Renew', switch_to_annual: 'Switch to annual billing for', monthly_after_annual: 'Annual billing until it renews:',
  upgrade: 'Upgrade to', downgrade: 'Switch at period end to', unavailable: 'Not available',
};

export function BillingManager({ catalog, current, returnedFromCheckout = false, highlightPlan = null }: { catalog: Catalog; current: Entitlements; returnedFromCheckout?: boolean; highlightPlan?: string | null }) {
  const router = useRouter();
  const firstSignature = useRef(subscriptionSignature(current));
  const [polls, setPolls] = useState(0);
  const changed = subscriptionSignature(current) !== firstSignature.current;
  const returnState = checkoutReturnState(returnedFromCheckout, changed, polls);
  const returnMessage = checkoutReturnMessage(returnState);
  // Coming back from Paystack: re-read the subscription a few times while the webhook may still be on its way. Nothing is assumed; the
  // server's answer is what changes the screen.
  useEffect(() => {
    if (returnState !== 'checking') return;
    const timer = setTimeout(() => { setPolls((n) => n + 1); router.refresh(); }, CHECKOUT_RETURN_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [returnState, polls, router]);
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');
  const [busy, setBusy] = useState('');

  const currentPlan = catalog.plans.find((p) => p.code === current.planCode);
  const highlightedPlan = highlightPlan ? catalog.plans.find((p) => p.code === highlightPlan && p.code !== 'free') : undefined;
  const currentMonthly = currentPlan ? currentPlan.monthlyPrice : null;
  const notices = lifecycleNotices(current, formatDate);
  const paidAndActive = current.status === 'Active' && current.planCode !== 'free';

  async function run(key: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    try { await work(); } catch (e) { toast.error(messageFor(e)); } finally { setBusy(''); }
  }

  const checkout = (plan: Plan) => run(`pay:${plan.code}`, async () => {
    const result = await api<Checkout>('/api/billing/subscription/checkout', { method: 'POST', json: { planCode: plan.code, billingPeriod: period } });
    window.location.assign(result.authorizationUrl);
  });
  const startTrial = (plan: Plan) => run(`trial:${plan.code}`, async () => {
    await api('/api/billing/subscription/trial', { method: 'POST', json: { planCode: plan.code } });
    toast.success(`Your ${plan.name} trial has started.`);
    router.refresh();
  });
  const schedule = (plan: Plan) => run(`change:${plan.code}`, async () => {
    await api('/api/billing/subscription/change', { method: 'POST', json: { planCode: plan.code } });
    toast.success(plan.code === 'free' ? 'Your subscription will end at the close of the paid period.' : `You will switch to ${plan.name} at the end of the paid period.`);
    router.refresh();
  });
  const cancelSchedule = () => run('change:cancel', async () => {
    await api('/api/billing/subscription/change/cancel', { method: 'POST' });
    toast.success('The scheduled plan change was cancelled.');
    router.refresh();
  });

  return (
    <div className="ap-stack">
      {returnMessage && <p className={returnState === 'delayed' ? 'ap-alert' : 'ap-ok'} role={returnState === 'delayed' ? 'alert' : 'status'}>{returnMessage}</p>}
      {highlightedPlan && highlightedPlan.code !== current.planCode && <p className="ap-ok" role="status">The template you were looking at is included from the {highlightedPlan.name} plan. Choose {highlightedPlan.name} below to unlock it. If you already pay for a plan, the unused part of your last payment is credited and you pay the difference.</p>}
      {notices.map((n) => (
        <p key={n.text} className={n.tone === 'warn' ? 'ap-alert' : 'ap-ok'} role={n.tone === 'warn' ? 'alert' : 'status'}>{n.text}</p>
      ))}
      <section className="ap-panel ap-stack">
        <h2 className="ap-h2">Current subscription</h2>
        <div className="ap-row">
          <strong>{current.planName}</strong>
          <span className="ap-badge">{statusLabel(current.status)}</span>
        </div>
        {paidAndActive && current.currentPeriodEndUtc && <p className="ap-foot">Paid until {formatDate(current.currentPeriodEndUtc)}.</p>}
        {current.pendingPlanCode && (
          <div className="ap-row">
            <span className="ap-foot">Scheduled: {current.pendingPlanCode === 'free' ? 'cancel at period end' : `switch to ${current.pendingPlanName ?? current.pendingPlanCode}`}.</span>
            <button className="ap-btn" disabled={!!busy} onClick={() => void cancelSchedule()}>{busy === 'change:cancel' ? 'Cancelling…' : 'Keep my current plan'}</button>
          </div>
        )}
        {paidAndActive && !current.pendingPlanCode && (
          <div>
            <button className="ap-btn" disabled={!!busy} onClick={() => { const free = catalog.plans.find((p) => p.code === 'free'); if (free) void schedule(free); }}>
              {busy === 'change:free' ? 'Scheduling…' : 'Cancel at period end'}
            </button>
            <p className="ap-foot">You keep your plan until the paid period ends. Your data is never deleted.</p>
          </div>
        )}
        <p className="ap-foot">Limits are enforced by the backend. A usage figure above its limit does not delete anything; it only stops new records of that kind until you upgrade or free up space.</p>
        <div className="ap-scroll">
          <table className="ap-table">
            <thead><tr><th>Feature</th><th>Current value</th><th>Usage</th></tr></thead>
            <tbody>
              {current.items.map((x) => (
                <tr key={x.key}>
                  <td>{x.description}<div className="ap-foot">{x.key}</div></td>
                  <td>{x.value}</td>
                  <td>{x.used ?? '—'}{x.overLimit && <span className="ap-badge ap-badge-off">Over limit</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="ap-row">
        <h2 className="ap-h2">Choose a plan</h2>
        <select className="ap-input" aria-label="Billing period" value={period} onChange={(e) => setPeriod(e.target.value as 'monthly' | 'annual')}>
          <option value="monthly">Monthly</option>
          <option value="annual">Annual</option>
        </select>
      </div>
      <div className="ap-grid2">
        {catalog.plans.filter((p) => p.code !== 'free').map((p) => {
          const price = priceForPeriod(p, period);
          const action = planAction(current, p, currentMonthly, { selectedPeriod: period, currentPeriod: current.billingPeriod ?? null });
          const scheduling = action === 'downgrade';
          const notAvailable = action === 'unavailable' || action === 'monthly_after_annual';
          const disabled = !!busy || notAvailable || (!scheduling && !canStartCheckout(price, !!busy)) || (scheduling && !!current.pendingPlanCode);
          const note = planActionNote(action, current.currentPeriodEndUtc, formatDate);
          return (
            <section className={`ap-panel ap-stack${highlightedPlan?.code === p.code ? ' ap-plan-highlight' : ''}`} key={p.code} aria-current={highlightedPlan?.code === p.code ? 'true' : undefined}>
              <h3 className="ap-h2">{p.name}</h3>
              <p className="ap-foot" style={{ margin: 0 }}>{p.description}</p>
              <strong style={{ fontSize: '1.5rem' }}>
                {price == null ? 'Price unavailable' : money(price, p.currencyCode)}
                <span className="ap-foot"> / {period === 'annual' ? 'year' : 'month'}</span>
              </strong>
              <button className="ap-btn" disabled={disabled} onClick={() => void (actionStartsCheckout(action) ? checkout(p) : schedule(p))}>
                {busy === `pay:${p.code}` || busy === `change:${p.code}` ? 'Working…' : `${BUTTON_LABEL[action]} ${action === 'unavailable' || action === 'monthly_after_annual' ? '' : p.name}`.trim()}
              </button>
              {note && <p className="ap-foot">{note}</p>}
              {current.canStartTrial && (
                <button className="ap-btn" disabled={!!busy} onClick={() => void startTrial(p)}>
                  {busy === `trial:${p.code}` ? 'Starting trial…' : `Try ${p.name} free for ${current.trialDays} days`}
                </button>
              )}
            </section>
          );
        })}
      </div>
      <p className="ap-foot">Payments are processed by Paystack. The subscription changes only after the server verifies the provider transaction. Checkout currently supports NGN plans. If a payment is missed you keep a grace period; after it your plan drops to Free limits and nothing is deleted or locked.</p>
    </div>
  );
}
