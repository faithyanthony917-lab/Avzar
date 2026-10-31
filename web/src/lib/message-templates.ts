import { ApiError } from '@/lib/problem';

// Step 16c: types and small helpers for the "Customer messages" settings panel (editable wording of customer text messages).

export type TemplateChannel = 'SMS' | 'WhatsApp';
// `fixed` (step 16d): WhatsApp is sent as a template approved by Meta, so its wording cannot be edited.
export type TemplateChannelState = { channel: TemplateChannel; customBody: string | null; usingDefault: boolean; updatedAtUtc: string | null; fixed?: boolean };
export type TemplateItem = {
  kind: 'order.ready' | 'order.amended' | 'payment.receipt' | 'appointment.reminder';
  label: string; description: string; defaultBody: string;
  placeholders: { name: string; description: string }[];
  channels: TemplateChannelState[];
};
export type TemplateList = { maxLength: number; optOutReservedCharacters: number; items: TemplateItem[] };
export type TemplatePreview = { text: string; characters: number; charactersWithOptOut: number };

/** Puts {name} at the cursor (or replaces the selection); the end of the text when no cursor is known. */
export function insertPlaceholder(text: string, name: string, start?: number | null, end?: number | null): { text: string; cursor: number } {
  const from = start == null ? text.length : Math.max(0, Math.min(start, text.length));
  const to = end == null ? from : Math.max(from, Math.min(end, text.length));
  const token = `{${name}}`;
  return { text: text.slice(0, from) + token + text.slice(to), cursor: from + token.length };
}

// Characters of the basic GSM-7 alphabet (a message with anything else is sent as Unicode and fits fewer characters per part).
const GSM7 = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/;

/** How many text-message parts a message of this length would take. Only a guide: real counts depend on the carrier. */
export function smsParts(text: string, length: number): number {
  if (length <= 0) return 0;
  const unicode = !GSM7.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return length <= single ? 1 : Math.ceil(length / multi);
}

/** The text to show for a failed save: the server's own reasons for the message field when there are any. */
export function templateErrorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const reasons = error.fields?.body;
    if (reasons?.length) return reasons.join(' ');
    return error.message || fallback;
  }
  return fallback;
}
