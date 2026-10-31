import { z } from 'zod';
import { tryNormalize } from '../email/addressRules.js';
import { parseSecret } from '../email/svix.js';

const bool = (fallback) => z.enum(['true', 'false']).default(fallback).transform((value) => value === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  HOST: z.string().min(1).default('0.0.0.0'),
  TRUSTED_PROXY_CIDRS: z.string().default(''),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  EXPO_ACCESS_TOKEN: z.string().default(''),
  JWT_SIGNING_KEY: z.string().optional(),
  CSRF_SIGNING_KEY: z.string().min(32).optional(),
  JWT_ISSUER: z.string().min(1).default('avzar-api'),
  JWT_AUDIENCE: z.string().min(1).default('avzar-mobile'),
  ACCESS_TOKEN_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  REFRESH_IDLE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  REFRESH_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(365).default(90),
  MAX_SESSIONS_PER_USER: z.coerce.number().int().min(1).max(100).default(10),
  REQUIRE_VERIFIED_EMAIL: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  ACCOUNT_TOKEN_KEY: z.string().min(32).optional(),
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
  STOREFRONT_CAPTCHA_SECRET_KEY: z.string().min(1).optional(),
  STOREFRONT_BASE_DOMAIN: z.string().min(1).default('avzar.app'),
  STOREFRONT_PREVIEW_MINUTES: z.coerce.number().int().min(1).max(120).default(30),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ALLOW_INSECURE_PUBLIC_BASE_URL: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  INVITATION_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  PLATFORM_ADMIN_EMAILS: z.string().default(''),
  STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./data/media'),
  STORAGE_S3_ENDPOINT: z.string().url().optional(),
  STORAGE_S3_REGION: z.string().min(1).default('us-east-1'),
  STORAGE_S3_BUCKET: z.string().optional(),
  STORAGE_S3_ACCESS_KEY: z.string().optional(),
  STORAGE_S3_SECRET_KEY: z.string().optional(),
  STORAGE_S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  STORAGE_S3_KEY_PREFIX: z.string().default(''),
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).max(100_000_000).default(12 * 1024 * 1024),
  MEDIA_MAX_PIXELS: z.coerce.number().int().min(1).max(500_000_000).default(50_000_000),
  DOCUMENT_MAX_UPLOAD_BYTES: z.coerce.number().int().min(1).max(100_000_000).default(15 * 1024 * 1024),
  STORAGE_QUOTA_BYTES_PER_GB: z.coerce.number().int().min(1).default(1_073_741_824),
  ANTIVIRUS_PROVIDER: z.enum(['none', 'clamav']).default('none'),
  ANTIVIRUS_HOST: z.string().min(1).default('localhost'),
  ANTIVIRUS_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  ANTIVIRUS_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
  ANTIVIRUS_REQUIRED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  BILLING_PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
  BILLING_PAYSTACK_CALLBACK_URL: z.string().url().optional(),
  AI_OPENAI_API_KEY: z.string().min(1).optional(),
  AI_OPENAI_IMAGE_MODEL: z.string().min(1).default('gpt-image-1'),
  AI_OPENAI_TEXT_MODEL: z.string().min(1).default('gpt-4.1-mini'),
  AI_DAILY_LIMIT_PER_BUSINESS: z.coerce.number().int().min(1).max(100_000).default(50),
  PRODUCT_NAME: z.string().min(1).max(60).default('Avzar'),
  EMAIL_VERIFICATION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  PASSWORD_RESET_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  EMAIL_THROTTLE_SECONDS: z.coerce.number().int().min(0).max(3600).default(120),
  // Mirror Database:MigrateOnStartup and Billing:SeedPlansOnStartup. Unset = on in development, off everywhere else.
  DATABASE_MIGRATE_ON_STARTUP: z.enum(['true', 'false']).optional(),
  BILLING_SEED_PLANS_ON_STARTUP: z.enum(['true', 'false']).optional(),
  // Email settings and their validation rules.
  EMAIL_PROVIDER: z.enum(['log', 'smtp', 'resend']).default('log'),
  EMAIL_FROM_ADDRESS: z.string().default(''),
  EMAIL_FROM_NAME: z.string().default('Avzar'),
  EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  EMAIL_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(20),
  EMAIL_POLL_SECONDS: z.coerce.number().int().min(1).default(5),
  EMAIL_LEASE_MINUTES: z.coerce.number().int().min(1).default(5),
  EMAIL_DISPATCHER_ENABLED: bool('true'),
  EMAIL_SMTP_HOST: z.string().default(''),
  EMAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  EMAIL_SMTP_STARTTLS: bool('true'),
  EMAIL_SMTP_USERNAME: z.string().default(''),
  EMAIL_SMTP_PASSWORD: z.string().default(''),
  EMAIL_RESEND_API_KEY: z.string().default(''),
  EMAIL_RESEND_BASE_URL: z.string().default('https://api.resend.com'),
  EMAIL_RESEND_WEBHOOK_SECRET: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  TWILIO_SMS_FROM: z.string().default(''),
  // Full public URL Twilio calls for inbound SMS; only needed when it differs from PUBLIC_BASE_URL + /api/messaging/twilio/inbound.
  TWILIO_INBOUND_WEBHOOK_URL: z.string().default(''),
  META_WHATSAPP_ACCESS_TOKEN: z.string().default(''),
  META_WHATSAPP_PHONE_NUMBER_ID: z.string().default(''),
  META_GRAPH_API_VERSION: z.string().default('v23.0'),
  // Step 16d: Meta webhook (verify handshake and signed inbound messages) and the language code the approved message templates were created in.
  META_WHATSAPP_APP_SECRET: z.string().default(''),
  META_WHATSAPP_VERIFY_TOKEN: z.string().default(''),
  META_WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en'),
  CUSTOMER_MESSAGE_WORKER_ENABLED: bool('true'),
  CUSTOMER_MESSAGE_WORKER_POLL_SECONDS: z.coerce.number().int().min(1).max(3600).default(15),
  // Step 17c: removes finished customer-message rows after 180 days and finished email rows after 90 days.
  RETENTION_WORKER_ENABLED: bool('true'),
  RETENTION_POLL_SECONDS: z.coerce.number().int().min(60).max(86400).default(21600),
  OVERDUE_TASK_REMINDERS_ENABLED: bool('true'),
  OVERDUE_TASK_REMINDER_POLL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  NOTIFICATION_SWEEP_ENABLED: bool('true'),
  NOTIFICATION_SWEEP_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  NOTIFICATION_OUTBOX_ENABLED: bool('true'),
  NOTIFICATION_OUTBOX_POLL_SECONDS: z.coerce.number().int().min(1).max(3600).default(10),
  WORKER_SUMMARY_ENABLED: bool('true'),
  WORKER_SUMMARY_POLL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  ORPHAN_CLEANUP_ENABLED: bool('true'),
  ORPHAN_CLEANUP_GRACE_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
  ORPHAN_CLEANUP_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(43200).default(360),
  ORPHAN_CLEANUP_MAX_DELETES: z.coerce.number().int().min(1).max(5000).default(500),
  BILLING_TRIAL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  BILLING_GRACE_DAYS: z.coerce.number().int().min(1).max(60).default(7),
  BILLING_ACTION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  SUBSCRIPTION_LIFECYCLE_ENABLED: bool('true'),
  SUBSCRIPTION_LIFECYCLE_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
}).superRefine((env, context) => {
  if (env.STORAGE_PROVIDER === 's3') {
    for (const key of ['STORAGE_S3_BUCKET', 'STORAGE_S3_ACCESS_KEY', 'STORAGE_S3_SECRET_KEY']) {
      if (!env[key]?.trim()) context.addIssue({ code: 'custom', path: [key], message: 'Required when STORAGE_PROVIDER=s3.' });
    }
    const prefix = env.STORAGE_S3_KEY_PREFIX;
    if (prefix.startsWith('/') || prefix.endsWith('/') || prefix.includes('..') || prefix.includes('//')) {
      context.addIssue({ code: 'custom', path: ['STORAGE_S3_KEY_PREFIX'], message: 'Must be a safe relative prefix.' });
    }
  }
  const emailIssue = (key, message) => context.addIssue({ code: 'custom', path: [key], message });
  if (env.EMAIL_PROVIDER === 'log' && env.NODE_ENV === 'production') {
    emailIssue('EMAIL_PROVIDER', "'log' writes messages (links included) to the log and never delivers them; use smtp or resend in production.");
  }
  if (env.EMAIL_RESEND_WEBHOOK_SECRET.trim() && !parseSecret(env.EMAIL_RESEND_WEBHOOK_SECRET)) {
    emailIssue('EMAIL_RESEND_WEBHOOK_SECRET', 'Must look like whsec_ followed by base64 (copy it from the Resend webhook page).');
  }
  if (env.EMAIL_PROVIDER !== 'log') {
    if (!tryNormalize(env.EMAIL_FROM_ADDRESS)) emailIssue('EMAIL_FROM_ADDRESS', 'Must be a valid address when a real provider is used.');
    if (env.EMAIL_PROVIDER === 'smtp' && !env.EMAIL_SMTP_HOST.trim()) emailIssue('EMAIL_SMTP_HOST', 'Required when EMAIL_PROVIDER=smtp.');
    if (env.EMAIL_PROVIDER === 'resend') {
      if (!env.EMAIL_RESEND_API_KEY.trim()) emailIssue('EMAIL_RESEND_API_KEY', 'Required when EMAIL_PROVIDER=resend.');
      if (!URL.canParse(env.EMAIL_RESEND_BASE_URL)) emailIssue('EMAIL_RESEND_BASE_URL', 'Must be an absolute URL.');
    }
  }
  if (env.ANTIVIRUS_REQUIRED && env.ANTIVIRUS_PROVIDER === 'none') {
    context.addIssue({ code: 'custom', path: ['ANTIVIRUS_REQUIRED'], message: 'Requires ANTIVIRUS_PROVIDER=clamav.' });
  }
}).transform((env) => {
  const dev = env.NODE_ENV === 'development';
  const flag = (value) => (value === undefined ? dev : value === 'true');
  return { ...env, DATABASE_MIGRATE_ON_STARTUP: flag(env.DATABASE_MIGRATE_ON_STARTUP), BILLING_SEED_PLANS_ON_STARTUP: flag(env.BILLING_SEED_PLANS_ON_STARTUP) };
});

export function loadEnv(source = process.env) {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid backend-node environment: ${details}`);
  }
  return parsed.data;
}
