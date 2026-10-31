// Structured view of the flat EMAIL_* environment.
export function emailOptionsFromEnv(env) {
  return {
    provider: env.EMAIL_PROVIDER,
    fromAddress: env.EMAIL_FROM_ADDRESS,
    fromName: env.EMAIL_FROM_NAME,
    maxAttempts: env.EMAIL_MAX_ATTEMPTS,
    batchSize: env.EMAIL_BATCH_SIZE,
    pollSeconds: env.EMAIL_POLL_SECONDS,
    leaseMinutes: env.EMAIL_LEASE_MINUTES,
    dispatcherEnabled: env.EMAIL_DISPATCHER_ENABLED,
    smtp: {
      host: env.EMAIL_SMTP_HOST, port: env.EMAIL_SMTP_PORT, startTls: env.EMAIL_SMTP_STARTTLS,
      username: env.EMAIL_SMTP_USERNAME, password: env.EMAIL_SMTP_PASSWORD,
    },
    resend: { apiKey: env.EMAIL_RESEND_API_KEY, baseUrl: env.EMAIL_RESEND_BASE_URL, webhookSecret: env.EMAIL_RESEND_WEBHOOK_SECRET },
  };
}
