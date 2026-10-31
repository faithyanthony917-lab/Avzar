import { createServer } from 'node:http';
import pg from 'pg';
import { loadEnv } from './config/env.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './http/app.js';
import { migrate } from './db/migrate.js';
import { installTenantRlsContext } from './db/tenantRlsContext.js';
import { syncPlans } from './db/planSeed.js';
import { startEmailDispatcher } from './email/dispatcher.js';
import { startOverdueTaskReminderWorker } from './email/overdueTaskReminders.js';
import { startOrphanCleanupWorker } from './storage/orphanCleanup.js';
import { startSubscriptionLifecycleWorker } from './auth/subscriptionLifecycleService.js';
import { startNotificationWorker } from './notifications/notificationWorker.js';
import { startNotificationOutboxWorker } from './notifications/notificationOutboxWorker.js';
import { configurePushSender } from './notifications/pushService.js';
import { startPushDeliveryWorker } from './notifications/pushDeliveryWorker.js';
import { startWorkerSummaryWorker } from './notifications/workerSummaryService.js';
import { startAppointmentReminderWorker } from './notifications/appointmentReminderWorker.js';
import { startCustomerMessageWorker } from './messaging/customerMessageWorker.js';
import { startCustomerEventWorker } from './messaging/customerEventWorker.js';
import { startRetentionWorker } from './retention/retentionWorker.js';
import { attachRealtimeHub, closeRealtimeConnections } from './realtime/events.js';

const env = loadEnv();
const pool = env.DATABASE_URL ? installTenantRlsContext(new pg.Pool({ connectionString: env.DATABASE_URL, max: env.DATABASE_POOL_MAX })) : null;

// Startup database work, off by default outside development (set DATABASE_MIGRATE_ON_STARTUP / BILLING_SEED_PLANS_ON_STARTUP).
// Migrations take an advisory lock, so several instances starting together are safe. Seed only AFTER migrations.
try {
  if (pool && env.DATABASE_MIGRATE_ON_STARTUP) {
    const applied = await migrate(pool, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations'), { info: (m) => console.info(JSON.stringify({ level: 'info', event: 'migration', message: m })) });
    console.info(JSON.stringify({ level: 'info', event: 'migrations_done', applied }));
  }
  if (pool && env.BILLING_SEED_PLANS_ON_STARTUP) {
    console.info(JSON.stringify({ level: 'info', event: 'plans_seeded', ...(await syncPlans(pool)) }));
  }
} catch (error) {
  console.error(JSON.stringify({ level: 'error', event: 'startup_database_failed', message: error.message }));
  process.exit(1);
}

const app = createApp(env, pool);
const server = createServer(app);
attachRealtimeHub(server, { env, pool });
const stopEmailDispatcher = startEmailDispatcher({ pool, env });
const stopOverdueTaskReminders = startOverdueTaskReminderWorker({
  pool, enabled: env.OVERDUE_TASK_REMINDERS_ENABLED, pollSeconds: env.OVERDUE_TASK_REMINDER_POLL_SECONDS,
});
const stopNotificationWorker = startNotificationWorker({
  pool, enabled: env.NOTIFICATION_SWEEP_ENABLED, intervalMinutes: env.NOTIFICATION_SWEEP_INTERVAL_MINUTES,
});
const pushSender = configurePushSender(env);
const stopPushDeliveryWorker = startPushDeliveryWorker({ pool, enabled: Boolean(pool && pushSender), sender: pushSender });
const stopNotificationOutboxWorker = startNotificationOutboxWorker({
  pool, enabled: env.NOTIFICATION_OUTBOX_ENABLED, pollSeconds: env.NOTIFICATION_OUTBOX_POLL_SECONDS,
});
const stopWorkerSummaries = startWorkerSummaryWorker({
  pool, enabled: env.WORKER_SUMMARY_ENABLED, pollSeconds: env.WORKER_SUMMARY_POLL_SECONDS,
});
const stopAppointmentReminders = startAppointmentReminderWorker({ pool });
const stopCustomerMessageWorker = startCustomerMessageWorker({ pool, env, enabled: env.CUSTOMER_MESSAGE_WORKER_ENABLED, pollSeconds: env.CUSTOMER_MESSAGE_WORKER_POLL_SECONDS });
const stopCustomerEventWorker = startCustomerEventWorker({ pool, env, enabled: env.CUSTOMER_MESSAGE_WORKER_ENABLED, pollSeconds: env.CUSTOMER_MESSAGE_WORKER_POLL_SECONDS });
const stopRetention = startRetentionWorker({ pool, enabled: env.RETENTION_WORKER_ENABLED, pollSeconds: env.RETENTION_POLL_SECONDS });
const stopOrphanCleanup = startOrphanCleanupWorker({
  pool, storage: app.locals.objectStorage, enabled: env.ORPHAN_CLEANUP_ENABLED,
  graceHours: env.ORPHAN_CLEANUP_GRACE_HOURS, intervalMinutes: env.ORPHAN_CLEANUP_INTERVAL_MINUTES,
  maxDeletes: env.ORPHAN_CLEANUP_MAX_DELETES,
});
const stopSubscriptionLifecycle = startSubscriptionLifecycleWorker({
  pool, enabled: env.SUBSCRIPTION_LIFECYCLE_ENABLED, graceDays: env.BILLING_GRACE_DAYS,
  intervalMinutes: env.SUBSCRIPTION_LIFECYCLE_INTERVAL_MINUTES,
});
server.listen(env.PORT, env.HOST, () => {
  console.info(JSON.stringify({ level: 'info', event: 'server_started', host: env.HOST, port: env.PORT, environment: env.NODE_ENV }));
});

function shutdown(signal) {
  console.info(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
  closeRealtimeConnections(); // open sockets would otherwise keep server.close() waiting
  const httpClosed = new Promise((resolve) => server.close((error) => {
    if (error) {
      console.error(JSON.stringify({ level: 'error', event: 'shutdown_failed', message: error.message }));
      process.exitCode = 1;
    }
    resolve();
  }));
  void Promise.all([httpClosed, stopEmailDispatcher(), stopOverdueTaskReminders(), stopNotificationWorker(), stopNotificationOutboxWorker(), stopPushDeliveryWorker(), stopWorkerSummaries(), stopAppointmentReminders(), stopCustomerMessageWorker(), stopCustomerEventWorker(), stopRetention(), stopOrphanCleanup(), stopSubscriptionLifecycle()]).then(() => {
    app.locals.objectStorage.close();
    pool?.end().catch(() => { process.exitCode = 1; });
  });
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
