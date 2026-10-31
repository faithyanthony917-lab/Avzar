'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import type { Customer, DuplicateCandidate } from '@/lib/customer-types';
import { blankToUndefined } from '@/lib/customers';
import { ApiError, messageFor } from '@/lib/problem';
import { Field, TextAreaField } from './Field';

/** Create (no `customer`) or edit (with `customer`). */
export function CustomerForm({ customer }: { customer?: Customer }) {
  const router = useRouter();
  const [fullName, setFullName] = useState(customer?.fullName ?? '');
  const [email, setEmail] = useState(customer?.email ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [addressLine, setAddressLine] = useState(customer?.addressLine ?? '');
  const [city, setCity] = useState(customer?.city ?? '');
  const [garmentPreferences, setGarmentPreferences] = useState(customer?.garmentPreferences ?? '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(allowDuplicate: boolean) {
    if (busy) return;
    setBusy(true); setError(null); setFields({}); setStale(false);
    try {
      const body = {
        fullName: fullName.trim(),
        email: blankToUndefined(email),
        phone: blankToUndefined(phone),
        addressLine: blankToUndefined(addressLine),
        city: blankToUndefined(city),
        garmentPreferences: blankToUndefined(garmentPreferences),
        notes: blankToUndefined(notes),
        allowDuplicate,
        version: customer?.version,
      };
      const saved = customer
        ? await api<Customer>(`/api/customers/${customer.id}`, { method: 'PUT', json: body })
        : await api<Customer>('/api/customers', { method: 'POST', json: body });
      router.push(`/customers/${saved.id}`);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'possible_duplicate') {
        const list = ((err.body as { candidates?: DuplicateCandidate[] } | undefined)?.candidates ?? []).filter((c) => c && c.id);
        setDuplicates(list);
      } else if (err instanceof ApiError && err.code === 'stale_version') {
        setStale(true);
        setError(err.message);
      } else {
        if (err instanceof ApiError) setFields(err.fields);
        setError(messageFor(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) { e.preventDefault(); setDuplicates(null); void save(false); }

  return (
    <form onSubmit={submit} className="ap-panel ap-form" aria-busy={busy}>
      <h2 className="ap-h2">{customer ? 'Edit customer' : 'New customer'}</h2>
      {error && (
        <p role="alert" className="ap-alert">
          {error}{stale && <> <button type="button" className="ap-link" onClick={() => router.refresh()}>Reload the latest version</button> (your edits on this page will be lost).</>}
        </p>
      )}
      {duplicates && (
        <div role="alert" className="ap-alert">
          <p style={{ margin: '0 0 .5rem' }}><strong>This looks like someone you already have.</strong></p>
          <ul className="ap-plain">
            {duplicates.map((d) => (
              <li key={d.id}><Link href={`/customers/${d.id}`}>{d.fullName}</Link> · {[d.email, d.phone].filter(Boolean).join(' · ') || 'no contact details'} · matched on {d.matchedOn}</li>
            ))}
          </ul>
          <div className="ap-row" style={{ justifyContent: 'flex-start', marginTop: '.75rem' }}>
            <button type="button" className="ap-btn ap-btn-sm" onClick={() => { setDuplicates(null); void save(true); }} disabled={busy}>{customer ? 'Save anyway' : 'Create anyway'}</button>
            <button type="button" className="ap-btn ap-btn-quiet ap-btn-sm" onClick={() => setDuplicates(null)}>Go back and edit</button>
          </div>
        </div>
      )}
      <Field id="c-name" label="Full name" required minLength={2} maxLength={120} autoComplete="off" value={fullName} onChange={setFullName} error={fields.fullName?.[0]} />
      <div className="ap-grid2">
        <Field id="c-email" label="Email" type="email" maxLength={256} autoComplete="off" value={email} onChange={setEmail} error={fields.email?.[0]} />
        <Field id="c-phone" label="Phone" type="tel" maxLength={40} autoComplete="off" value={phone} onChange={setPhone} error={fields.phone?.[0]} />
      </div>
      <div className="ap-grid2">
        <Field id="c-address" label="Address" maxLength={300} autoComplete="off" value={addressLine} onChange={setAddressLine} error={fields.addressLine?.[0]} />
        <Field id="c-city" label="City" maxLength={100} autoComplete="off" value={city} onChange={setCity} error={fields.city?.[0]} />
      </div>
      <TextAreaField id="c-prefs" label="Garment preferences" maxLength={2000} value={garmentPreferences} onChange={setGarmentPreferences} error={fields.garmentPreferences?.[0]} hint="Fabrics, fits, colours, anything to remember when taking an order." />
      <TextAreaField id="c-notes" label="Notes" maxLength={4000} value={notes} onChange={setNotes} error={fields.notes?.[0]} />
      <div className="ap-row" style={{ justifyContent: 'flex-start' }}>
        <button className="ap-btn" type="submit" disabled={busy}>{busy ? 'Saving…' : customer ? 'Save changes' : 'Create customer'}</button>
        <Link href={customer ? `/customers/${customer.id}` : '/customers'} className="ap-btn ap-btn-quiet" style={{ textDecoration: 'none' }}>Cancel</Link>
      </div>
    </form>
  );
}
