'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';

type Product = { designId: string; name: string; description: string | null; price: number | null; currencyCode: string | null; variantId: string; sku: string; size: string | null; colour: string | null; available: number };
type ProductResult = { items: Product[]; storefront: { name: string; slug: string } };

export function ReadyToWearCheckout({ slug }: { slug: string }) {
  const [items, setItems] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [loading, setLoading] = useState(true);
  const idempotencyKey = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    api<ProductResult>(`/api/public/sites/${encodeURIComponent(slug)}/ready-to-wear`).then((result) => { if (active) setItems(result.items ?? []); })
      .catch((e) => { if (active) setError(messageFor(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [slug]);

  async function checkout() {
    const cart = items.filter((item) => (selected[item.variantId] ?? 0) > 0).map((item) => ({ variantId: item.variantId, quantity: selected[item.variantId] }));
    if (!cart.length) { setError('Choose at least one item.'); return; }
    if (!name.trim() || !email.trim()) { setError('Enter your name and email address.'); return; }
    setBusy(true); setError('');
    try {
      if (!idempotencyKey.current) idempotencyKey.current = globalThis.crypto?.randomUUID?.() ?? null;
      const key = idempotencyKey.current;
      if (!key) throw new Error('Secure checkout key generation is unavailable in this browser.');
      const result = await api<{ authorizationUrl: string }>(`/api/public/sites/${encodeURIComponent(slug)}/ready-to-wear/checkout`, {
        method: 'POST', idempotencyKey: key, json: { customerName: name.trim(), email: email.trim(), phone: phone.trim() || undefined, items: cart },
      });
      window.location.assign(result.authorizationUrl);
    } catch (e) { setError(messageFor(e)); setBusy(false); }
  }

  return <section className="rtw-wrap" aria-labelledby="rtw-heading"><h2 id="rtw-heading">Shop ready-to-wear</h2>
    <p>Choose available sizes and colours, then continue to secure payment.</p>
    {error && <p className="rtw-error" role="alert">{error}</p>}
    {loading ? <p>Loading products…</p> : items.length === 0 ? <p>No ready-to-wear items are currently available for online purchase.</p> : <div className="rtw-products">{items.map((item) => <article className="rtw-product" key={item.variantId}>
      <h3>{item.name}</h3>{item.description ? <p>{item.description}</p> : null}
      <p><strong>{item.price == null ? 'Price unavailable' : (item.currencyCode ? new Intl.NumberFormat(undefined, { style: 'currency', currency: item.currencyCode }).format(item.price) : new Intl.NumberFormat(undefined).format(item.price))}</strong></p>
      <p>{[item.size, item.colour].filter(Boolean).join(' · ') || item.sku}</p><p>{item.available} available</p>
      <label>Quantity <select value={selected[item.variantId] ?? 0} disabled={busy || item.available < 1} onChange={(e) => setSelected((current) => ({ ...current, [item.variantId]: Number(e.target.value) }))}>
        <option value={0}>Not selected</option>{Array.from({ length: Math.min(20, item.available) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
      </select></label>
    </article>)}</div>}
    <div className="rtw-customer"><h3>Delivery contact</h3><label>Full name<input autoComplete="name" maxLength={120} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label><label>Email<input type="email" autoComplete="email" maxLength={254} value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} /></label><label>Phone (optional)<input type="tel" autoComplete="tel" maxLength={40} value={phone} disabled={busy} onChange={(e) => setPhone(e.target.value)} /></label><button type="button" disabled={busy || loading || items.length === 0} onClick={() => void checkout()}>{busy ? 'Starting secure checkout…' : 'Continue to payment'}</button></div>
  </section>;
}
