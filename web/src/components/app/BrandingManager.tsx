'use client';

import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';

export type Branding = {
  accentColor: string | null;
  logoMediaId: string | null;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
  footerNote: string | null;
};

const FALLBACK_ACCENT = '#1F3A5F';
const HEX = /^#[0-9a-f]{6}$/i;

/** Document branding printed on invoices, credit notes and receipts. The server saves the whole form: a blank field clears that value. */
export function BrandingManager({ initial }: { initial: Branding }) {
  const [useAccent, setUseAccent] = useState(Boolean(initial.accentColor));
  const [accent, setAccent] = useState(HEX.test(initial.accentColor ?? '') ? initial.accentColor! : FALLBACK_ACCENT);
  const [phone, setPhone] = useState(initial.phone ?? '');
  const [email, setEmail] = useState(initial.email ?? '');
  const [taxNumber, setTaxNumber] = useState(initial.taxNumber ?? '');
  const [footerNote, setFooterNote] = useState(initial.footerNote ?? '');
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const saved = await api<Branding>('/api/business/branding', {
        method: 'PUT',
        json: {
          accentColor: useAccent ? accent : null,
          phone: phone.trim() || null,
          email: email.trim() || null,
          taxNumber: taxNumber.trim() || null,
          footerNote: footerNote.trim() || null,
          logoMediaId: initial.logoMediaId, // passed through so saving this form never clears an existing logo
        },
      });
      setUseAccent(Boolean(saved.accentColor));
      if (saved.accentColor) setAccent(saved.accentColor);
      setPhone(saved.phone ?? ''); setEmail(saved.email ?? ''); setTaxNumber(saved.taxNumber ?? ''); setFooterNote(saved.footerNote ?? '');
      toast.success('Document branding saved. New PDFs will use it.');
    } catch (err) { toast.error(messageFor(err)); }
    finally { setBusy(false); }
  }

  return (
    <section className="ap-panel ap-stack" aria-labelledby="branding-heading">
      <h2 id="branding-heading" className="ap-h2">Document branding</h2>
      <p className="ap-foot" style={{ margin: 0 }}>Contact details and colour printed on invoices, credit notes and receipts.</p>
      <form className="ap-grid2" onSubmit={save}>
        <div className="ap-field">
          <label className="ap-check"><input type="checkbox" checked={useAccent} disabled={busy} onChange={(e) => setUseAccent(e.target.checked)} /> Use an accent colour</label>
          <input id="branding-accent" className="ap-input" type="color" aria-label="Accent colour" value={accent} disabled={busy || !useAccent} onChange={(e) => setAccent(e.target.value.toUpperCase())} />
          <span className="ap-hint">Colours too light to read on white paper are rejected.</span>
        </div>
        <div className="ap-field"><label htmlFor="branding-phone">Business phone</label><input id="branding-phone" className="ap-input" maxLength={40} value={phone} disabled={busy} onChange={(e) => setPhone(e.target.value)} /></div>
        <div className="ap-field"><label htmlFor="branding-email">Business email</label><input id="branding-email" className="ap-input" type="email" maxLength={254} value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="ap-field"><label htmlFor="branding-tax">Tax number</label><input id="branding-tax" className="ap-input" maxLength={60} value={taxNumber} disabled={busy} onChange={(e) => setTaxNumber(e.target.value)} /></div>
        <div className="ap-field" style={{ gridColumn: '1 / -1' }}><label htmlFor="branding-footer">Document footer</label><textarea id="branding-footer" className="ap-input" maxLength={300} rows={3} value={footerNote} disabled={busy} onChange={(e) => setFooterNote(e.target.value)} /></div>
        <div><button className="ap-btn" disabled={busy}>{busy ? 'Saving…' : 'Save branding'}</button></div>
      </form>
    </section>
  );
}
