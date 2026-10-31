'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/client';
import { messageFor } from '@/lib/problem';
import { toast } from '@/lib/toast';
import {
  insertPlaceholder, smsParts, templateErrorText,
  type TemplateChannel, type TemplateChannelState, type TemplateItem, type TemplateList, type TemplatePreview,
} from '@/lib/message-templates';

const BASE = '/api/business/message-templates';

function KindEditor({ item, maxLength }: { item: TemplateItem; maxLength: number }) {
  const [channels, setChannels] = useState<TemplateChannelState[]>(item.channels);
  const [channel, setChannel] = useState<TemplateChannel>('SMS');
  const state = channels.find((c) => c.channel === channel)!;
  const saved = state.customBody ?? item.defaultBody;
  const [drafts, setDrafts] = useState<Record<TemplateChannel, string>>({
    SMS: item.channels.find((c) => c.channel === 'SMS')?.customBody ?? item.defaultBody,
    WhatsApp: item.channels.find((c) => c.channel === 'WhatsApp')?.customBody ?? item.defaultBody,
  });
  const [busy, setBusy] = useState<'save' | 'reset' | 'preview' | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<TemplatePreview | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const text = drafts[channel];
  const dirty = text !== saved;
  const id = `tpl-${item.kind.replace('.', '-')}`;

  const setText = (value: string) => { setDrafts((d) => ({ ...d, [channel]: value })); setPreview(null); setError(''); };
  const switchChannel = (next: TemplateChannel) => { setChannel(next); setPreview(null); setError(''); };

  const mergeState = (next: Partial<TemplateChannelState> & { channel: TemplateChannel }) =>
    setChannels((list) => list.map((c) => (c.channel === next.channel ? { ...c, ...next } : c)));

  function addPlaceholder(name: string) {
    const el = area.current;
    const result = insertPlaceholder(text, name, el?.selectionStart, el?.selectionEnd);
    setText(result.text);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(result.cursor, result.cursor); });
  }

  async function runPreview() {
    setBusy('preview'); setError('');
    try { setPreview(await api<TemplatePreview>(`${BASE}/${item.kind}/preview`, { method: 'POST', json: { body: text } })); }
    catch (err) { setPreview(null); setError(templateErrorText(err, messageFor(err))); }
    finally { setBusy(null); }
  }

  async function save() {
    setBusy('save'); setError('');
    try {
      const result = await api<TemplateChannelState>(`${BASE}/${item.kind}/${channel}`, { method: 'PUT', json: { body: text } });
      mergeState({ channel, customBody: result.customBody, usingDefault: false, updatedAtUtc: result.updatedAtUtc });
      setDrafts((d) => ({ ...d, [channel]: result.customBody ?? d[channel] }));
      toast.success(`${item.label} wording saved for ${channel}.`);
    } catch (err) { setError(templateErrorText(err, messageFor(err))); }
    finally { setBusy(null); }
  }

  async function reset() {
    setBusy('reset'); setError('');
    try {
      await api(`${BASE}/${item.kind}/${channel}`, { method: 'DELETE' });
      mergeState({ channel, customBody: null, usingDefault: true, updatedAtUtc: null });
      setDrafts((d) => ({ ...d, [channel]: item.defaultBody }));
      setPreview(null);
      toast.success(`${item.label} wording for ${channel} is back to the default.`);
    } catch (err) { setError(templateErrorText(err, messageFor(err))); }
    finally { setBusy(null); }
  }

  const parts = preview && channel === 'SMS' ? smsParts(preview.text, preview.charactersWithOptOut) : 0;

  return <article className="ap-panel ap-stack" aria-labelledby={`${id}-h`}>
    <div className="ap-row"><h3 id={`${id}-h`} className="ap-h3">{item.label}</h3>
      <span className="ap-badge">{state.fixed ? 'Set by Meta' : state.usingDefault ? 'Default wording' : 'Your wording'}</span></div>
    <p className="ap-foot" style={{ margin: 0 }}>{item.description}</p>
    <div className="ap-actions" role="group" aria-label={`${item.label} channel`}>
      {(['SMS', 'WhatsApp'] as const).map((c) => <button key={c} type="button" className={`ap-btn ap-btn-sm ${c === channel ? '' : 'ap-btn-quiet'}`} aria-pressed={c === channel} onClick={() => switchChannel(c)}>{c}</button>)}
    </div>
    {state.fixed ? <p className="ap-hint">WhatsApp messages use a template approved by Meta, so their wording is fixed and cannot be changed here. They carry the same details as the text message, plus your opt-out link.</p> : <>
    <div className="ap-field">
      <label htmlFor={id}>{item.label} message for {channel}</label>
      <textarea id={id} ref={area} className="ap-input" rows={5} maxLength={maxLength + 200} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-hint`} />
      <p id={`${id}-hint`} className="ap-foot" style={{ margin: 0 }}>{text.length} of {maxLength} characters. Every message ends with the opt-out line, which is added for you.</p>
    </div>
    <div className="ap-actions" role="group" aria-label="Placeholders">
      {item.placeholders.map((p) => <button key={p.name} type="button" className="ap-btn ap-btn-quiet ap-btn-sm" title={p.description} onClick={() => addPlaceholder(p.name)}>{`{${p.name}}`}</button>)}
    </div>
    <ul className="ap-foot" style={{ margin: 0, paddingLeft: '1.1rem' }}>
      {item.placeholders.map((p) => <li key={p.name}><code>{`{${p.name}}`}</code> {p.description}</li>)}
    </ul>
    {error && <p className="ap-alert" role="alert">{error}</p>}
    {preview && <div className="ap-stack" role="status">
      <strong>Preview with sample details</strong>
      <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{preview.text}</p>
      <p className="ap-foot" style={{ margin: 0 }}>{preview.characters} characters, about {preview.charactersWithOptOut} with the opt-out line{channel === 'SMS' ? `; roughly ${parts} text ${parts === 1 ? 'part' : 'parts'}` : ''}.</p>
    </div>}
    <div className="ap-actions">
      <button type="button" className="ap-btn" disabled={busy !== null || !dirty || text.trim() === ''} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save wording'}</button>
      <button type="button" className="ap-btn ap-btn-quiet" disabled={busy !== null || text.trim() === ''} onClick={() => void runPreview()}>{busy === 'preview' ? 'Previewing…' : 'Preview'}</button>
      <button type="button" className="ap-btn ap-btn-quiet" disabled={busy !== null || state.usingDefault} onClick={() => void reset()}>{busy === 'reset' ? 'Resetting…' : 'Reset to default'}</button>
    </div>
    </>}
  </article>;
}

/** Settings panel: the wording of the text messages customers receive. Customer messages only; staff notices are not editable. */
export function MessageTemplatesPanel() {
  const [list, setList] = useState<TemplateList | null>(null);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try { setList(await api<TemplateList>(BASE)); }
    catch (err) { setLoadError(messageFor(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <section className="ap-panel ap-stack" aria-labelledby="customer-messages-h">
    <h2 id="customer-messages-h" className="ap-h2">Customer messages</h2>
    <p className="ap-foot" style={{ margin: 0 }}>Change the words of the text messages your customers receive. Only customers who agreed to messages are sent them, and the opt-out line is always added at the end.</p>
    {loadError && <div role="alert" className="ap-alert"><p>{loadError}</p><button type="button" className="ap-btn ap-btn-quiet" onClick={() => void load()}>Retry loading messages</button></div>}
    {list === null && !loadError && <p className="ap-foot" role="status">Loading message wording…</p>}
    {list?.items.map((item) => <KindEditor key={item.kind} item={item} maxLength={list.maxLength} />)}
  </section>;
}
