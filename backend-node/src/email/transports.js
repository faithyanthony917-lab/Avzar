// Delivery transports. Each one resolves to a classified TransportResult and must not throw for delivery problems.
import { TransportResult } from './transportResult.js';

const SMTP_RETRY_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED', 'EDNS', 'EAUTH', 'ETLS']);
const safeName = (name) => String(name ?? '').replace(/[\u0000-\u001f\u007f"]/g, '').trim();

/** Development only. Logs the whole message (including any links), so never use it where logs are shared. */
export function createLogTransport({ log = console.info } = {}) {
  return {
    name: 'log',
    async send(email) {
      log(JSON.stringify({ level: 'info', event: 'email_not_delivered', to: email.to, subject: email.subject, body: email.textBody }));
      return TransportResult.ok('log');
    },
  };
}

/** Resend HTTP API. The message id is sent as the Idempotency-Key. */
export function createResendTransport({ options, fetchImpl = globalThis.fetch, timeoutMs = 15_000 }) {
  const from = safeName(options.fromName) ? `${safeName(options.fromName)} <${options.fromAddress}>` : options.fromAddress;
  return {
    name: 'resend',
    async send(email) {
      const payload = { from, to: [email.to], subject: email.subject, text: email.textBody };
      if (email.htmlBody != null) payload.html = email.htmlBody;
      try {
        const res = await fetchImpl(`${options.resend.baseUrl.replace(/\/+$/, '')}/emails`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.resend.apiKey}`,
            'idempotency-key': String(email.messageId).replaceAll('-', ''),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          try { return TransportResult.ok((await res.json())?.id ?? null); } catch { return TransportResult.ok(null); }
        }
        const code = res.status;
        // 429 rate limit, 409 concurrent idempotent request, 408 and 5xx provider trouble: try again. Other 4xx will not improve.
        return code === 429 || code === 409 || code === 408 || code >= 500
          ? TransportResult.retry(`Resend HTTP ${code}`)
          : TransportResult.reject(`Resend HTTP ${code}`);
      } catch (error) {
        return TransportResult.retry(`Resend request failed: ${error?.name ?? 'Error'}`);
      }
    },
  };
}

/** SMTP through nodemailer, loaded lazily so a deployment that does not use SMTP never needs the package. */
export function createSmtpTransport({ options, loadNodemailer = () => import('nodemailer') }) {
  let transporter = null;
  async function getTransporter() {
    if (transporter) return transporter;
    const mod = await loadNodemailer();
    const nodemailer = mod.default ?? mod;
    const { host, port, startTls, username, password } = options.smtp;
    transporter = nodemailer.createTransport({
      host, port,
      secure: port === 465, // implicit TLS on 465; otherwise STARTTLS is required when enabled
      requireTLS: startTls && port !== 465,
      auth: username ? { user: username, pass: password } : undefined,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
    return transporter;
  }
  return {
    name: 'smtp',
    /** Fails fast at startup with a clear message when nodemailer is not installed. */
    async ready() {
      try { await getTransporter(); } catch (error) {
        throw new Error(`EMAIL_PROVIDER=smtp needs the "nodemailer" package (npm install nodemailer): ${error.message}`);
      }
    },
    async send(email) {
      let t;
      try { t = await getTransporter(); } catch { return TransportResult.retry('SMTP library unavailable'); }
      try {
        await t.sendMail({
          from: { name: safeName(options.fromName), address: options.fromAddress },
          to: email.to,
          subject: email.subject,
          text: email.textBody,
          ...(email.htmlBody != null && { html: email.htmlBody }),
          headers: { 'X-Avzar-Message-Id': String(email.messageId) },
        });
        return TransportResult.ok(null); // plain SMTP gives no provider message id
      } catch (error) {
        const responseCode = Number(error?.responseCode);
        if (responseCode >= 400 && responseCode < 500) return TransportResult.retry(`SMTP ${responseCode}`);
        if (responseCode >= 500) return TransportResult.reject(`SMTP ${responseCode}`);
        if (error?.code === 'EENVELOPE' || error?.code === 'EMESSAGE') return TransportResult.reject(`Invalid address or message: ${error.code}`);
        if (SMTP_RETRY_CODES.has(error?.code)) return TransportResult.retry(`SMTP connection problem: ${error.code}`);
        return TransportResult.retry(`SMTP failed: ${error?.name ?? 'Error'}`);
      }
    },
  };
}

export function createEmailTransport(options, dependencies = {}) {
  switch (options.provider) {
    case 'log': return createLogTransport(dependencies);
    case 'smtp': return createSmtpTransport({ options, ...dependencies });
    case 'resend': return createResendTransport({ options, ...dependencies });
    default: throw new Error(`EMAIL_PROVIDER '${options.provider}' is not supported. Use log, smtp or resend.`);
  }
}
