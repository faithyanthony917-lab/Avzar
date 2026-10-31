'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/client';
import { CHANNELS, DIRECTIONS, channelLabel, directionLabel } from '@/lib/customers';
import { ApiError, messageFor } from '@/lib/problem';
import { Field, SelectField, TextAreaField } from './Field';
import { toast } from '@/lib/toast';

export interface LogEntry { id: string; channel: string; direction: string; subject: string | null; body: string; when: string }

export function CommunicationLog({ customerId, entries, canManage }: { customerId: string; entries: LogEntry[]; canManage: boolean }) {
  const router = useRouter();
  const [channel, setChannel] = useState('Phone');
  const [direction, setDirection] = useState('Outbound');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setFields({});
    try {
      await api(`/api/customers/${customerId}/communications`, { method: 'POST', json: { channel, direction, subject: subject.trim() || undefined, body: body.trim() } });
      setSubject(''); setBody('');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) setFields(err.fields);
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ap-stack">
      {canManage && (
        <form onSubmit={add} className="ap-form" aria-busy={busy}>
          <div className="ap-grid2">
            <SelectField id="comm-channel" label="How" value={channel} onChange={setChannel} options={CHANNELS} error={fields.channel?.[0]} />
            <SelectField id="comm-direction" label="Who reached out" value={direction} onChange={setDirection} options={DIRECTIONS} error={fields.direction?.[0]} />
          </div>
          <Field id="comm-subject" label="Subject (optional)" maxLength={200} value={subject} onChange={setSubject} error={fields.subject?.[0]} />
          <TextAreaField id="comm-body" label="What was said" required maxLength={4000} value={body} onChange={setBody} error={fields.body?.[0]} />
          <div><button className="ap-btn" type="submit" disabled={busy || !body.trim()}>{busy ? 'Saving…' : 'Add to log'}</button></div>
        </form>
      )}
      {entries.length === 0 ? <p className="ap-hint" style={{ margin: 0 }}>Nothing logged yet.</p> : (
        <ol className="ap-plain ap-log">
          {entries.map((c) => (
            <li key={c.id}>
              <p className="ap-hint" style={{ margin: 0 }}>{c.when} · {channelLabel(c.channel)} · {directionLabel(c.direction)}</p>
              {c.subject && <p style={{ margin: '.15rem 0 0' }}><strong>{c.subject}</strong></p>}
              <p className="ap-pre" style={{ margin: '.15rem 0 0' }}>{c.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
