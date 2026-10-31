import express from 'express';
import { randomBytes } from 'node:crypto';
import { loadEnv } from '../config/env.js';
import { createAccountRouter } from '../auth/accountRoutes.js';
import { createAdminRouter } from '../auth/adminRoutes.js';
import { SAVE_DESIGN_PATH, WEBHOOK_PATH, createBillingRouter } from '../auth/billingRoutes.js';
import { createBusinessSettingsRouter } from '../auth/businessSettings.js';
import { createCatalogRouter } from '../auth/catalogRoutes.js';
import { createCoreAuthRouter } from '../auth/coreAuthRoutes.js';
import { createCustomerRouter } from '../auth/customerRoutes.js';
import { CUSTOMER_PRIVACY_CREATE_PATH, CUSTOMER_PRIVACY_LIST_PATH, createCustomerPrivacyRouter } from '../auth/customerPrivacyRoutes.js';
import { createFinanceRouter } from '../auth/financeRoutes.js';
import { createMediaRouter, createPublicMediaRouter } from '../auth/mediaRoutes.js';
import { createObjectStorage } from '../auth/objectStorage.js';
import { createNotificationRouter } from '../notifications/notificationRoutes.js';
import { createVirusScanner } from '../auth/documentService.js';
import { createMobileAuthRouter } from '../auth/mobileAuth.js';
import { createOrderRouter } from '../auth/orderRoutes.js';
import { PORTAL_QUOTATIONS_PATH, PORTAL_QUOTATION_RESPOND_PATH, createQuotationRouter } from '../auth/quotationRoutes.js';
import { createPublicSiteRouter } from '../auth/publicSiteRoutes.js';
import { createReportsRouter } from '../auth/reportsRoutes.js';
import { createProductionViewRouter } from '../auth/productionViewRoutes.js';
import { READY_TO_WEAR_WEBHOOK_PATH, createReadyToWearRouter } from '../auth/readyToWearRoutes.js';
import { INVOICE_PAYMENT_WEBHOOK_PATH, PORTAL_INVOICE_PAY_PATH, createInvoicePaymentRouter } from '../auth/invoicePaymentRoutes.js';
import { createInstallmentRouter } from '../auth/installmentRoutes.js';
import { createStaffRouter } from '../auth/staffRoutes.js';
import { createStorefrontRouter } from '../auth/storefrontRoutes.js';
import { createSupplyRouter } from '../auth/supplyRoutes.js';
import { createMessageTemplateRouter } from '../auth/messageTemplateRoutes.js';
import { STOREFRONT_ANALYTICS_PUBLIC_PREFIX, createStorefrontAnalyticsRouter } from '../auth/storefrontAnalyticsRoutes.js';
import { createEmailWebhookRouter, RESEND_WEBHOOK_PATH } from '../email/webhookRoutes.js';
import { createConfiguredMessagingProvider } from '../messaging/provider.js';
import { TWILIO_INBOUND_PATH, UNSUBSCRIBE_CONFIRM_PATH, UNSUBSCRIBE_PREVIEW_PATH, WHATSAPP_WEBHOOK_PATH, createPublicMessagingRouter } from '../messaging/publicMessagingRoutes.js';
import { csrfProtection } from '../security/csrf.js';
import { attachRealtimeHub } from '../realtime/events.js';
import { errorHandler } from './errors.js';
import { checkDatabaseReadiness } from './readiness.js';
import { runWithTenantRlsContext } from '../db/tenantRlsContext.js';
import { requestIdMiddleware } from './requestId.js';
import { securityHeaders } from './securityHeaders.js';

export function createApp(env = loadEnv(), dbPool = null, dependencies = {}) {
  const app = express();
  app.use(requestIdMiddleware());
  // Isolate tenant identity per HTTP request; authenticated route middleware binds it from the signed token.
  app.use((_req, _res, next) => runWithTenantRlsContext(next));
  const storage = dependencies.storage ?? createObjectStorage(env);
  const virusScanner = dependencies.virusScanner ?? createVirusScanner(env);
  const billingProvider = dependencies.billingProvider;
  const aiProvider = dependencies.aiProvider;
  const analyticsProvider = dependencies.analyticsProvider;
  const messagingProvider = dependencies.messagingProvider ?? createConfiguredMessagingProvider(env);
  app.locals.messagingProvider = messagingProvider;
  app.locals.objectStorage = storage;
  app.disable('x-powered-by');
  const trustedProxies = String(env.TRUSTED_PROXY_CIDRS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  app.set('trust proxy', trustedProxies.length ? trustedProxies : false);

  app.use(securityHeaders(env));
  // Webhook signatures are computed over the exact raw bytes, so keep them. The large AI image-save body is parsed
  // inside its own route after authentication, so unauthenticated callers can never make the server buffer 18 MB.
  const defaultJson = express.json({ limit: '1mb', strict: true, verify: (req, _res, buf) => { if ([WEBHOOK_PATH, READY_TO_WEAR_WEBHOOK_PATH, INVOICE_PAYMENT_WEBHOOK_PATH, WHATSAPP_WEBHOOK_PATH].includes(req.originalUrl.split('?')[0])) req.rawBody = Buffer.from(buf); } });
  app.use((req, res, next) => ([SAVE_DESIGN_PATH, RESEND_WEBHOOK_PATH].includes(req.originalUrl.split('?')[0]) ? next() : defaultJson(req, res, next)));

  const configuredCsrfSecret = env.CSRF_SIGNING_KEY || env.JWT_SIGNING_KEY;
  if (env.NODE_ENV === 'production' && (!configuredCsrfSecret || configuredCsrfSecret.length < 32)) {
    throw new Error('Set CSRF_SIGNING_KEY or a 32-character JWT_SIGNING_KEY in production.');
  }
  const csrfSecret = configuredCsrfSecret || randomBytes(32).toString('base64url');
  app.use('/api', csrfProtection({
    secret: csrfSecret,
    ignore: (req) => req.originalUrl.split('?')[0].startsWith(STOREFRONT_ANALYTICS_PUBLIC_PREFIX) || ['/api/auth/token', '/api/auth/token/refresh', '/api/auth/token/revoke', '/api/customer-portal/access', PORTAL_QUOTATIONS_PATH, PORTAL_QUOTATION_RESPOND_PATH, CUSTOMER_PRIVACY_CREATE_PATH, CUSTOMER_PRIVACY_LIST_PATH, '/api/billing/subscription/webhook', READY_TO_WEAR_WEBHOOK_PATH, INVOICE_PAYMENT_WEBHOOK_PATH, PORTAL_INVOICE_PAY_PATH, RESEND_WEBHOOK_PATH, UNSUBSCRIBE_PREVIEW_PATH, UNSUBSCRIBE_CONFIRM_PATH, TWILIO_INBOUND_PATH, WHATSAPP_WEBHOOK_PATH].includes(req.originalUrl.split('?')[0]),
  }));

  app.get('/health/live', (_req, res) => res.status(200).json({ status: 'live', service: 'avzar-pwa-node' }));
  const readiness = async (_req, res) => {
    const result = await checkDatabaseReadiness(dbPool);
    if (!result.ready) return res.status(503).json({ status: 'not_ready', reason: result.reason });
    return res.status(200).json({ status: 'ready', service: 'avzar-node', database: 'healthy' });
  };
  app.get('/health/ready', readiness);
  app.get('/health', readiness); // /health checks the database (200 healthy / 503 unhealthy)
  app.get('/api/v1', (_req, res) => res.status(200).json({ service: 'avzar-node' }));
  attachRealtimeHub(app, { env, pool: dbPool });
  app.use('/api', createCoreAuthRouter({ env, pool: dbPool, csrfSecret }));
  app.use('/api', createAdminRouter({ env, pool: dbPool }));
  app.use('/api', createAccountRouter({ env, pool: dbPool }));
  app.use('/api', createBusinessSettingsRouter({ env, pool: dbPool }));
  app.use('/api', createStaffRouter({ env, pool: dbPool }));
  app.use('/api', createMediaRouter({ env, pool: dbPool, storage, virusScanner }));
  app.use('/api', createCustomerRouter({ env, pool: dbPool }));
  app.use('/api', createCustomerPrivacyRouter({ env, pool: dbPool }));
  app.use('/api', createCatalogRouter({ env, pool: dbPool }));
  app.use('/api', createReadyToWearRouter({ env, pool: dbPool, ...(billingProvider && { billingProvider }) }));
  app.use('/api', createOrderRouter({ env, pool: dbPool }));
  app.use('/api', createProductionViewRouter({ env, pool: dbPool }));
  app.use('/api', createQuotationRouter({ env, pool: dbPool }));
  app.use('/api', createFinanceRouter({ env, pool: dbPool }));
  app.use('/api', createInvoicePaymentRouter({ env, pool: dbPool, ...(billingProvider && { billingProvider }) }));
  app.use('/api', createInstallmentRouter({ env, pool: dbPool }));
  app.use('/api', createSupplyRouter({ env, pool: dbPool }));
  app.use('/api', createMessageTemplateRouter({ env, pool: dbPool }));
  app.use('/api', createPublicMessagingRouter({ env, pool: dbPool }));
  app.use('/api', createReportsRouter({ env, pool: dbPool }));
  app.use('/api', createNotificationRouter({ env, pool: dbPool }));
  app.use('/', createPublicMediaRouter({ env, pool: dbPool, storage }));
  app.use('/api', createStorefrontRouter({ env, pool: dbPool }));
  app.use('/api', createStorefrontAnalyticsRouter({ env, pool: dbPool, secret: csrfSecret, ...(analyticsProvider && { provider: analyticsProvider }) }));
  app.use('/api', createEmailWebhookRouter({ env, pool: dbPool }));
  app.use('/', createPublicSiteRouter({ env, pool: dbPool }));
  app.use('/api', createBillingRouter({ env, pool: dbPool, storage, ...(billingProvider && { billingProvider }), ...(aiProvider && { aiProvider }) }));
  app.use('/api', createMobileAuthRouter({ env, pool: dbPool }));

  app.use((req, res) => res.status(404).json({ code: 'not_found', message: 'The requested resource was not found.' }));
  app.use(errorHandler());
  return app;
}
