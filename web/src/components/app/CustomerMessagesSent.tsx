'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';

export type CustomerMessage = {
  id: string; kind: 'order.amended' | 'order.ready' | 'payment.receipt'; channel: 'SMS' | 'WhatsApp'; address: string;
  status: 'Pending' | 'Leased' | 'Sent' | 'Cancelled' | 'Failed'; error: string | null; createdAtUtc: string; sentAtUtc: string | null;
};

const KIND_LABEL: Record<CustomerMessage['kind'], string> = { 'order.amended': 'Order updated', 'order.ready': 'Order ready', 'payment.receipt': 'Payment receipt' };
const STATUS_LABEL: Record<CustomerMessage['status'], string> = {
  Pending: 'Waiting to send', Leased: 'Sending', Sent: 'Sent', Cancelled: 'Not sent (cancelled)', Failed: 'Failed',
};
const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '');

export function CustomerMessagesSent({ customerId }: { customerId: string }) {
  const [messages, setMessages] = useState<CustomerMessage[] | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try { setMessages(await api<CustomerMessage[]>(`/api/customers/${customerId}/messages`)); }
    catch (err) { setLoadError(messageFor(err)); }
  }, [customerId]);

  useEffect(() => { void load(); }, [load]);

  return <section className="ap-panel ap-stack" aria-labelledby="messages-sent-h">
    <h2 id="messages-sent-h" className="ap-h2">Order and payment messages</h2>
    <p className="ap-foot">Messages Avzar queued for this customer when an order changed, became ready or a payment was received. Only customers with a recorded opt-in receive them.</p>
    {loadError && <div role="alert" className="ap-alert"><p>{loadError}</p><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void load()}>Retry loading messages</button></div>}
    {messages === null && !loadError && <p className="ap-foot" aria-live="polite">Loading messages…</p>}
    {messages?.length === 0 && <p className="ap-hint">No order or payment messages have been queued for this customer.</p>}
    {messages?.map((message) => <article key={message.id} className="ap-panel ap-stack">
      <div className="ap-row"><strong>{KIND_LABEL[message.kind]}</strong><span className="ap-badge">{STATUS_LABEL[message.status]}</span></div>
      <p className="ap-foot">{message.channel} {message.address} · {message.sentAtUtc ? `Sent ${when(message.sentAtUtc)}` : `Queued ${when(message.createdAtUtc)}`}</p>
      {message.error && <p className="ap-hint">Last error: {message.error}</p>}
    </article>)}
  </section>;
}
