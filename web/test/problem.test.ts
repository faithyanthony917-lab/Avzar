import { describe, expect, it } from 'vitest';
import { ApiError, messageFor, readProblem } from '../src/lib/problem';

const res = (status: number, body?: unknown) => new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status });

describe('readProblem', () => {
  it('reads the code and title from an application error', async () => {
    const e = await readProblem(res(401, { status: 401, title: 'Enter the code from your authenticator app.', code: 'two_factor_required' }));
    expect(e.code).toBe('two_factor_required');
    expect(e.status).toBe(401);
    expect(e.message).toBe('Enter the code from your authenticator app.');
  });
  it('maps validation errors to lower-camel field names', async () => {
    const e = await readProblem(res(400, { title: 'One or more validation errors occurred.', errors: { Password: ['too short'], BusinessName: ['required'] } }));
    expect(e.fields.password).toEqual(['too short']);
    expect(e.fields.businessName).toEqual(['required']);
    expect(e.message).toBe('Please fix the highlighted fields.');
  });
  it('keeps the body so the caller can read extra data', async () => {
    const e = await readProblem(res(409, { code: 'choose_business', choices: [{ businessId: 'a', businessName: 'A' }] }));
    expect((e.body as { choices: unknown[] }).choices).toHaveLength(1);
  });
  it('survives an empty body', async () => expect((await readProblem(res(401))).message).toContain('not signed in'));
  it('survives a non-JSON body', async () => expect((await readProblem(res(502, '<html>bad gateway</html>'))).message).toContain('Something went wrong'));
  it('never shows server internals for 5xx', async () => expect((await readProblem(res(500, { title: 'NullReferenceException at X' }))).message).not.toContain('NullReference'));
  it('shows the configuration message for 503', async () => expect((await readProblem(res(503, { title: 'Subscription plans are not configured on this server.', code: 'plans_not_seeded' }))).message).toContain('plans'));
  it('explains rate limiting', async () => expect((await readProblem(res(429))).message).toContain('Wait a minute'));
  it('uses the lockout message', async () => expect((await readProblem(res(423, { title: 'Too many failed attempts. Try again later.', code: 'locked_out' }))).message).toContain('Try again later'));
});

describe('messageFor', () => {
  it('passes an ApiError message through', () => expect(messageFor(new ApiError(400, 'Bad thing'))).toBe('Bad thing'));
  it('hides anything else behind a generic message', () => expect(messageFor(new TypeError('boom'))).toContain('Could not reach the server'));
});
