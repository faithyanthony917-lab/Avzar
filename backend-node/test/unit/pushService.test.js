import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configurePushSender, createExpoPushSender, getPushSender } from '../../src/notifications/pushService.js';

describe('push sender transport', () => {
  it('does not configure a sender without an Expo access token', () => {
    assert.equal(createExpoPushSender({ EXPO_ACCESS_TOKEN: '' }), null);
    configurePushSender({ EXPO_ACCESS_TOKEN: '' });
    assert.equal(getPushSender(), null);
  });

  it('sends generic messages through the injectable transport and returns per-message tickets', async () => {
    let request;
    const sender = createExpoPushSender({ EXPO_ACCESS_TOKEN: 'secret' }, async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }] }) };
    });
    const tickets = await sender.send([{ to: 'ExponentPushToken[test]', title: 'Production task update', body: 'A production task has been assigned to you.', data: { eventType: 'task.assignment' } }]);
    assert.equal(request.url, 'https://exp.host/--/api/v2/push/send');
    assert.equal(request.options.headers.Authorization, 'Bearer secret');
    const payload = JSON.parse(request.options.body);
    assert.equal(payload[0].to, 'ExponentPushToken[test]');
    assert.equal(payload[0].data.source, 'avzar');
    assert.deepEqual(tickets, [{ status: 'ok', id: 'ticket-1' }]);
  });

  it('preserves provider HTTP status for retry classification', async () => {
    const sender = createExpoPushSender({ EXPO_ACCESS_TOKEN: 'secret' }, async () => ({ ok: false, status: 503 }));
    await assert.rejects(sender.send([{ to: 'token' }]), (error) => error.status === 503);
  });
});
