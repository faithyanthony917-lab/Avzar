// Outcome of ONE delivery attempt. Transient failures are retried; permanent ones are dead-lettered.
const truncate = (text) => (text.length <= 400 ? text : text.slice(0, 400));

export const TransportResult = Object.freeze({
  ok: (providerMessageId = null) => ({ success: true, transient: false, providerMessageId, error: null }),
  retry: (error) => ({ success: false, transient: true, providerMessageId: null, error: truncate(String(error)) }),
  reject: (error) => ({ success: false, transient: false, providerMessageId: null, error: truncate(String(error)) }),
});
