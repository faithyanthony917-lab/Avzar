'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

type Bank = { name: string; code: string };

/** Settings panel: where customers' online payments are paid out. The account number is sent once and never shown again. */
export function PaymentAccountPanel() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [accountName, setAccountName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false);
  const [banks, setBanks] = useState<Bank[] | null>(null);
  const [bankError, setBankError] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  
  useEffect(() => {
    let active = true;
    api<{ configured: boolean }>('/api/business/payment-account')
      .then((value) => { if (active) setConfigured(value.configured); })
      .catch((err) => { if (active) setLoadError(messageFor(err)); });
    return () => { active = false; };
  }, []);

  const openForm = useCallback(async () => {
    setEditing(true); setError(''); setBankError('');
    if (banks) return;
    try { setBanks((await api<{ items: Bank[] }>('/api/business/payment-account/banks')).items); }
    catch (err) { setBankError(messageFor(err)); }
  }, [banks]);

  async function save(event: FormEvent) {
    event.preventDefault();
    const digits = accountNumber.replace(/\s/g, '');
    if (!bankCode) { setError('Choose your bank.'); return; }
    if (!/^\d{10}$/.test(digits)) { setError('Enter the 10-digit account number.'); return; }
    setBusy(true); setError('');
    try {
      const saved = await api<{ configured: boolean; accountName: string | null }>('/api/business/payment-account', { method: 'PUT', json: { bankCode, accountNumber: digits } });
      setConfigured(saved.configured); setAccountName(saved.accountName ?? null);
      setAccountNumber(''); setBankCode(''); setEditing(false);
      toast.success('Payout account saved. Customers can now pay invoices online.');
    } catch (err) { toast.error(messageFor(err)); } finally { setBusy(false); }
  }

  return <section className="ap-panel ap-stack" aria-labelledby="payout-account">
    <h2 id="payout-account" className="ap-h2">Online payments</h2>
    <p className="ap-foot" style={{ margin: 0 }}>Customers pay by card through Paystack and the money goes to this bank account. Paystack&apos;s fee is taken from each payment.</p>
    {loadError ? <p className="ap-alert" role="alert">{loadError}</p>
      : configured === null ? <p className="ap-foot" role="status">Loading payout account…</p>
      : <p role="status">{configured ? <span className="ap-badge ap-badge-on">Payout account set up</span> : <span className="ap-badge">Not set up</span>}{accountName && <> {accountName}</>}</p>}
    {configured !== null && !editing && <div className="ap-actions"><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void openForm()}>{configured ? 'Change payout account' : 'Set up payout account'}</button></div>}
    {editing && <form className="ap-stack" onSubmit={(e) => void save(e)}>
      {bankError ? <p className="ap-alert" role="alert">{bankError}</p> : banks === null ? <p className="ap-foot" role="status">Loading banks…</p> : <>
        <div className="ap-field"><label htmlFor="payout-bank">Bank</label>
          <select id="payout-bank" className="ap-input" value={bankCode} disabled={busy} onChange={(e) => setBankCode(e.target.value)}>
            <option value="">Choose your bank</option>{banks.map((bank) => <option key={bank.code} value={bank.code}>{bank.name}</option>)}
          </select></div>
        <div className="ap-field"><label htmlFor="payout-number">Account number</label>
          <input id="payout-number" className="ap-input" inputMode="numeric" autoComplete="off" maxLength={20} value={accountNumber} disabled={busy} onChange={(e) => setAccountNumber(e.target.value)} />
          <p className="ap-foot" style={{ margin: 0 }}>We send this to Paystack and do not keep it.</p></div>
        {error && <p className="ap-alert" role="alert">{error}</p>}
        <div className="ap-actions"><button className="ap-btn" disabled={busy}>{busy ? 'Saving…' : 'Save payout account'}</button><button type="button" className="ap-btn ap-btn-quiet" disabled={busy} onClick={() => { setEditing(false); setError(''); }}>Cancel</button></div>
      </>}
    </form>}
  </section>;
}
