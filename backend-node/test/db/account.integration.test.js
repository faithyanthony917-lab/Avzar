// Runs the account service SQL against a real PostgreSQL with the migrations applied. Skipped unless DATABASE_URL is set (CI job "node-db").
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { hashPassword } from '../../src/security/passwordHasher.js';
import { computeCode, decodeBase32, stepAt } from '../../src/security/totp.js';
import { accountTokenKey, issueAccountToken, PURPOSE_RESET_PASSWORD } from '../../src/security/accountTokens.js';
import * as account from '../../src/auth/accountService.js';
import { dispatchOnce } from '../../src/email/dispatcher.js';
import { handleResendWebhook } from '../../src/email/webhookService.js';
import { parseSecret, sign } from '../../src/email/svix.js';

const url = process.env.DATABASE_URL;
const env = { JWT_SIGNING_KEY: 'integration-signing-key-with-at-least-32-chars', WEB_BASE_URL: 'https://app.example.test' };
const PASSWORD = 'correct horse battery';
let pool;

async function makeUser() {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO "AspNetUsers" ("Id","AccessFailedCount","CreatedAtUtc","Email","EmailConfirmed","FullName","LockoutEnabled","NormalizedEmail","NormalizedUserName","PasswordHash","PhoneNumberConfirmed","SecurityStamp","TwoFactorEnabled","UserName")
     VALUES ($1,0,now(),$2::text,false,'Test User',true,upper($2::text),upper($2::text),$3,false,$4,false,$2::text)`,
    [id, `${id}@example.test`, await hashPassword(PASSWORD), randomUUID()]);
  return id;
}
async function makeSession(userId) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO "UserSessions" ("Id","AbsoluteExpiresAtUtc","BusinessId","CreatedAtUtc","CurrentTokenHash","DeviceName","IdleExpiresAtUtc","LastUsedAtUtc","UserId")
     VALUES ($1, now() + interval '1 day', $2, now(), 'h', 'Test phone', now() + interval '1 day', now(), $3)`, [id, randomUUID(), userId]);
  return id;
}
const row = async (id) => (await pool.query('SELECT * FROM "AspNetUsers" WHERE "Id" = $1', [id])).rows[0];
const code = (key) => computeCode(decodeBase32(key), stepAt(new Date()));
const rejects = (promise, status, errCode) => assert.rejects(promise, (e) => e.status === status && e.code === errCode);

describe('account service against PostgreSQL', { skip: !url }, () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    await migrate(pool, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations'), { info() {} });
  });
  after(async () => { await pool?.end(); });

  it('reset link works once, rotates the security stamp and revokes device sessions', async () => {
    const id = await makeUser();
    const sessionId = await makeSession(id);
    const before = await row(id);
    const token = issueAccountToken(accountTokenKey(env), { Id: id, Email: before.Email, SecurityStamp: before.SecurityStamp, PasswordHash: before.PasswordHash }, PURPOSE_RESET_PASSWORD, 600);
    await account.resetPassword(pool, env, { userId: id, token, newPassword: 'a brand new passphrase' });
    const after = await row(id);
    assert.notEqual(after.SecurityStamp, before.SecurityStamp);
    assert.notEqual(after.PasswordHash, before.PasswordHash);
    const s = await pool.query('SELECT "RevokedAtUtc","RevokedReason" FROM "UserSessions" WHERE "Id" = $1', [sessionId]);
    assert.equal(s.rows[0].RevokedReason, 'password_reset');
    await rejects(account.resetPassword(pool, env, { userId: id, token, newPassword: 'another passphrase here' }), 400, 'invalid_token');
  });

  it('forgot-password queues one email and throttles the second request', async () => {
    const id = await makeUser();
    const email = (await row(id)).Email;
    await account.requestPasswordReset(pool, env, email);
    await account.requestPasswordReset(pool, env, email);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "EmailOutbox" WHERE "ToAddress" = $1 AND "TemplateKey" = 'password_reset'`, [email]);
    assert.equal(rows[0].n, 1);
  });

  it('dispatches a queued message and purges its body after successful delivery', async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO "EmailOutbox" ("Id","Attempts","CreatedAtUtc","NextAttemptUtc","Status","Subject","TextBody","ToAddress")
      VALUES ($1,0,now(),now(),'Pending','Test delivery','one-time-link','dispatch@example.test')`, [id]);
    const sent = [];
    let count = 0;
    for (let attempt = 0; attempt < 100 && !sent.some((email) => email.messageId === id); attempt++) {
      count += await dispatchOnce({
        pool, options: { batchSize: 1, leaseMinutes: 5, maxAttempts: 3 }, log: {},
        transport: { send: async (email) => { sent.push(email); return { success: true, transient: false, providerMessageId: 'provider-test-id' }; } },
      });
    }

    assert.ok(count > 0);
    assert.deepEqual(sent.find(({ messageId }) => messageId === id), {
      messageId: id, to: 'dispatch@example.test', subject: 'Test delivery', textBody: 'one-time-link', htmlBody: null,
    });
    const { rows } = await pool.query('SELECT "Status","TextBody","ProviderMessageId","BodyPurgedAtUtc" FROM "EmailOutbox" WHERE "Id" = $1', [id]);
    assert.deepEqual(rows[0], { Status: 'Sent', TextBody: '', ProviderMessageId: 'provider-test-id', BodyPurgedAtUtc: rows[0].BodyPurgedAtUtc });
    assert.ok(rows[0].BodyPurgedAtUtc instanceof Date);
  });

  it('marks a queued message for a suppressed address failed without contacting the provider', async () => {
    const id = randomUUID();
    const address = `${id}@example.test`;
    await pool.query(`INSERT INTO "EmailOutbox" ("Id","Attempts","CreatedAtUtc","NextAttemptUtc","Status","Subject","TextBody","ToAddress")
      VALUES ($1,0,now(),now(),'Pending','Test suppression','one-time-link',$2)`, [id, address]);
    await pool.query(`INSERT INTO "EmailSuppressions" ("Id","Address","CreatedAtUtc","Reason") VALUES ($1,$2,now(),'complaint')`, [randomUUID(), address.toLowerCase()]);
    let sends = 0;
    await dispatchOnce({
      pool, options: { batchSize: 10, leaseMinutes: 5, maxAttempts: 3 }, log: {},
      transport: { send: async () => { sends++; return { success: true, transient: false, providerMessageId: null }; } },
    });

    assert.equal(sends, 0);
    const { rows } = await pool.query('SELECT "Status","TextBody","LastError" FROM "EmailOutbox" WHERE "Id" = $1', [id]);
    assert.equal(rows[0].Status, 'Failed');
    assert.equal(rows[0].TextBody, '');
    assert.match(rows[0].LastError, /suppression list/);
  });

  it('records a permanent Resend bounce once and never downgrades its delivery status', async () => {
    const id = randomUUID();
    const providerId = `provider-${id}`;
    const address = `Ada+${id}@Example.test`;
    await pool.query(`INSERT INTO "EmailOutbox" ("Id","Attempts","CreatedAtUtc","NextAttemptUtc","ProviderMessageId","SentAtUtc","Status","Subject","TextBody","ToAddress")
      VALUES ($1,1,now(),now(),$2,now(),'Sent','Test bounce','',$3)`, [id, providerId, address]);
    const secret = `whsec_${Buffer.alloc(32, 11).toString('base64')}`;
    const send = async (event) => {
      const body = JSON.stringify({ type: event.type, data: { email_id: providerId, ...(event.bounce && { bounce: event.bounce }) } });
      const eventId = `evt-${randomUUID()}`;
      const timestamp = String(Math.floor(Date.now() / 1000));
      return handleResendWebhook({ pool, secret, id: eventId, timestamp,
        signature: `v1,${sign(parseSecret(secret), eventId, timestamp, body)}`, body });
    };

    assert.equal(await send({ type: 'email.bounced', bounce: { type: 'Permanent', message: 'Mailbox gone' } }), 'applied');
    assert.equal(await send({ type: 'email.delivery_delayed' }), 'no_change');
    const outbox = await pool.query('SELECT "DeliveryStatus","DeliveryDetail" FROM "EmailOutbox" WHERE "Id" = $1', [id]);
    assert.deepEqual(outbox.rows[0], { DeliveryStatus: 'Bounced', DeliveryDetail: 'Mailbox gone' });
    const suppression = await pool.query('SELECT "Address","Reason" FROM "EmailSuppressions" WHERE "Address" = $1', [address.toLowerCase()]);
    assert.deepEqual(suppression.rows, [{ Address: address.toLowerCase(), Reason: 'Bounced' }]);
  });

  it('email confirmation sets EmailConfirmed and resend then conflicts', async () => {
    const id = await makeUser();
    await account.sendEmailVerification(pool, env, id);
    const mail = (await pool.query(`SELECT "TextBody" FROM "EmailOutbox" WHERE "ToAddress" = $1 AND "TemplateKey" = 'verify_email'`, [(await row(id)).Email])).rows[0];
    const token = decodeURIComponent(/token=([^\s]+)/.exec(mail.TextBody)[1]);
    await account.confirmEmail(pool, env, { userId: id, token });
    assert.equal((await row(id)).EmailConfirmed, true);
    await rejects(account.sendEmailVerification(pool, env, id), 409, 'email_already_confirmed');
  });

  it('two-factor: enable consumes the code, replay is refused, recovery code disables once', async () => {
    const id = await makeUser();
    const { sharedKey } = await account.beginTwoFactorSetup(pool, env, id);
    await rejects(account.enableTwoFactor(pool, id, null, { code: '000000' }), 400, 'invalid_code');
    const { codes } = await account.enableTwoFactor(pool, id, null, { code: code(sharedKey) });
    assert.equal(codes.length, 10);
    assert.equal((await account.getSecurity(pool, id)).recoveryCodesLeft, 10);
    await rejects(account.disableTwoFactor(pool, id, null, { password: PASSWORD, code: code(sharedKey) }), 400, 'invalid_code'); // same step: replay
    await rejects(account.disableTwoFactor(pool, id, null, { password: 'wrong password!!', recoveryCode: codes[0] }), 400, 'wrong_password');
    await account.disableTwoFactor(pool, id, null, { password: PASSWORD, recoveryCode: codes[0] });
    assert.equal((await row(id)).TwoFactorEnabled, false);
    assert.equal((await account.getSecurity(pool, id)).recoveryCodesLeft, 0);
  });

  it('sessions: list, revoke own, other user gets 404, revoke-all', async () => {
    const a = await makeUser(); const b = await makeUser();
    const s1 = await makeSession(a); const s2 = await makeSession(a); const sb = await makeSession(b);
    assert.equal((await account.listSessions(pool, a)).length, 2);
    await rejects(account.revokeSessionById(pool, a, sb), 404, 'session_not_found');
    await account.revokeSessionById(pool, a, s1);
    assert.deepEqual((await account.listSessions(pool, a)).map((x) => x.id), [s2]);
    await account.revokeAllSessionsForUser(pool, a);
    assert.equal((await account.listSessions(pool, a)).length, 0);
    assert.equal((await account.listSessions(pool, b)).length, 1);
  });

  it('delete anonymises the user, frees the email, and the account stops resolving', async () => {
    const id = await makeUser();
    await makeSession(id);
    await rejects(account.deleteAccount(pool, id, null, { password: 'wrong password!!' }), 400, 'wrong_password');
    await account.deleteAccount(pool, id, null, { password: PASSWORD });
    const u = await row(id);
    assert.equal(u.FullName, 'Deleted user');
    assert.equal(u.PasswordHash, null);
    assert.match(u.Email, /@deleted\.invalid$/);
    await rejects(account.getSecurity(pool, id), 401, 'unknown_user');
    assert.equal((await account.listSessions(pool, id)).length, 0);
  });
});
