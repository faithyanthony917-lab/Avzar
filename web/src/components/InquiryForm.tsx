'use client';

import Script from 'next/script';
import { useState, type FormEvent } from 'react';

type Props = {
  slug: string;
  kind: 'Inquiry' | 'Quotation' | 'OrderRequest' | 'Appointment' | 'Contact';
  heading?: string;
  intro?: string;
  designId?: string;
  designName?: string;
  /** Preview mode never sends anything. */
  disabled?: boolean;
};

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

const ERRORS: Record<string, string> = {
  contact_required: 'Please add an email address or a phone number so we can reply.',
  invalid_text: 'Please remove the < and > characters.',
  workflow_disabled: 'This business is not taking these requests through the site right now.',
  captcha_failed: 'Please complete the check and try again.',
  too_many_requests: 'You have sent several messages recently. Please wait a while and try again.',
  date_required: 'Please choose a day.',
  invalid_date: 'That date does not look right.',
  unknown_design: 'That design is no longer available.',
};

export default function InquiryForm({ slug, kind, heading, intro, designId, designName, disabled }: Props) {
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const id = `f-${kind}-${designId ?? 'site'}`;
  const askDate = kind === 'Appointment';
  const orderFields = kind === 'OrderRequest';

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    setError(null);
    setState('sending');
    const form = new FormData(e.currentTarget);
    const text = (k: string) => (String(form.get(k) ?? '').trim() || undefined);
    const body = {
      kind,
      name: text('name'), email: text('email'), phone: text('phone'), message: text('message'),
      designId, garmentType: text('garmentType'), budget: text('budget'),
      preferredDate: text('preferredDate'), eventDate: text('eventDate'),
      website: text('website'),                       // honeypot: stays empty for people
      captchaToken: text('cf-turnstile-response'),
    };
    try {
      const res = await fetch(`/api/inquiry/${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) { setState('done'); return; }
      const problem = (await res.json().catch(() => ({}))) as { code?: string; title?: string };
      setError((problem.code && ERRORS[problem.code]) || 'Something went wrong. Please try again.');
    } catch {
      setError('We could not reach the server. Please check your connection and try again.');
    }
    setState('idle');
  }

  if (state === 'done') {
    return <p role="status" className="form-ok">Thank you. We have received your message and will get back to you.</p>;
  }

  return (
    <form className="form" onSubmit={onSubmit} aria-labelledby={`${id}-h`} noValidate={false}>
      {heading ? <h2 id={`${id}-h`}>{heading}</h2> : null}
      {intro ? <p className="muted">{intro}</p> : null}
      {designName ? <p className="muted">About: <strong>{designName}</strong></p> : null}
      {disabled ? <p role="note" className="form-note">Forms are switched off in preview.</p> : null}

      <label htmlFor={`${id}-name`}>Your name</label>
      <input id={`${id}-name`} name="name" required minLength={2} maxLength={100} autoComplete="name" />

      <div className="form-row">
        <div>
          <label htmlFor={`${id}-email`}>Email</label>
          <input id={`${id}-email`} name="email" type="email" maxLength={120} autoComplete="email" />
        </div>
        <div>
          <label htmlFor={`${id}-phone`}>Phone</label>
          <input id={`${id}-phone`} name="phone" type="tel" maxLength={40} autoComplete="tel" />
        </div>
      </div>
      <p className="muted small">Add at least one, so we can reply.</p>

      {askDate ? (<><label htmlFor={`${id}-pd`}>Preferred day</label><input id={`${id}-pd`} name="preferredDate" type="date" required /></>) : null}
      {orderFields ? (
        <>
          <label htmlFor={`${id}-g`}>What would you like made?</label>
          <input id={`${id}-g`} name="garmentType" maxLength={60} placeholder="e.g. Agbada, two-piece suit, wedding gown" />
          <div className="form-row">
            <div><label htmlFor={`${id}-b`}>Budget</label><input id={`${id}-b`} name="budget" maxLength={60} /></div>
            <div><label htmlFor={`${id}-e`}>Event date</label><input id={`${id}-e`} name="eventDate" type="date" /></div>
          </div>
        </>
      ) : null}

      <label htmlFor={`${id}-msg`}>Message</label>
      <textarea id={`${id}-msg`} name="message" required minLength={3} maxLength={2000} rows={5} />

      {/* Honeypot: hidden from people and assistive tech, attractive to bots. */}
      <div className="hp" aria-hidden="true"><label>Leave this empty<input name="website" tabIndex={-1} autoComplete="off" /></label></div>

      {SITE_KEY ? (<><div className="cf-turnstile" data-sitekey={SITE_KEY} /><Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" strategy="afterInteractive" /></>) : null}

      {error ? <p role="alert" className="form-error">{error}</p> : null}
      <button className="btn" type="submit" disabled={state === 'sending' || disabled}>{state === 'sending' ? 'Sending…' : 'Send'}</button>
    </form>
  );
}
