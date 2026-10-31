const DEFAULT_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export function createExpoPushSender(env = {}, fetchImpl = fetch) {
  const token = typeof env.EXPO_ACCESS_TOKEN === 'string' ? env.EXPO_ACCESS_TOKEN.trim() : '';
  if (!token) return null;
  return {
    async send(messages) {
      const values = Array.isArray(messages) ? messages.filter((message) => message?.to) : [];
      if (!values.length) return [];
      const response = await fetchImpl(DEFAULT_EXPO_PUSH_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(values.map((message) => ({ ...message, sound: message.sound ?? 'default', data: { ...(message.data ?? {}), source: 'avzar' } }))),
      });
      if (!response.ok) {
        const error = new Error(`Expo push request failed (${response.status}).`);
        error.status = response.status;
        throw error;
      }
      const payload = await response.json().catch(() => ({}));
      return Array.isArray(payload?.data) ? payload.data : [];
    },
  };
}

let activeSender = null;
export function configurePushSender(env = {}, fetchImpl = fetch) {
  activeSender = createExpoPushSender(env, fetchImpl);
  return activeSender;
}
export function getPushSender() { return activeSender; }
