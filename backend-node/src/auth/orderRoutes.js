import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { bindTenantByLookup } from '../db/tenantLookup.js';
import { readMultipart } from '../http/multipart.js';
import { publishTaskUpdated } from '../realtime/events.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import { applyShopSchedule, listShopScheduleVersions, previewShopSchedule } from './productionScheduleService.js';
import { notify } from '../notifications/notificationService.js';
import { queueCustomerEvent } from '../messaging/customerEvents.js';
import {
  addWorkerLeave,
  cancelWorkerLeave,
  getWorkerAvailability,
  getWorkerCalendar,
  intersectCalendarFeedLocations,
  listPendingWorkerLeave,
  listWorkerLeave,
  requestMyLeave,
  reviewWorkerLeave,
  setWorkerAvailability,
} from './workerScheduleService.js';
import {
  cancelAppointment,
  createAppointment,
  listAppointments,
  rescheduleAppointment,
  setAppointmentStatus,
} from './appointmentService.js';
import { createFitting, listFittings, setFittingStatus } from './fittingService.js';
import { sendCsv } from './csvExport.js';
import { respondList, windowedRows } from './listWindow.js';
import { exportAppointments, exportOrders } from './exportService.js';
import { appointmentIcsEvent, renderIcs, taskIcsEvent } from './calendarIcs.js';
import { openTaskPhoto, uploadMedia, MAX_REFERENCE_IMAGES } from './mediaService.js';
import { deleteOrderReferenceImage, listOrderReferenceImages, listTaskReferenceImages, openOrderReferenceImage, openTaskReferenceImage } from './orderReferenceImages.js';
import { addMoney, hasAtMostPlaces, mulMoney, subtractMoney } from '../money.js';
import { ciEnum } from '../http/ciEnum.js';
import { calculatePricing } from './pricingService.js';
import { pricingInputSchema } from './pricingSchemas.js';
import { isBlank, parseEnum } from '../http/enums.js';
import {
  ORDER_STATUSES,
  allowedNextStatuses,
  canTransition,
  isEditable,
  isProductionActive,
  isProductionOpen,
  sqlStatusList,
  PRODUCTION_ACTIVE,
} from './orderTransitions.js';
import { pickWorkflow, planLineRegeneration, sameCategory } from './orderAmendmentPlan.js';

const garmentSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(80).nullish(),
  quantity: z.number().int().min(1).max(10_000).default(1),
  unitPrice: z.number().min(0).max(100_000_000),
  fabric: z.string().trim().max(120).nullish(),
  colour: z.string().trim().max(60).nullish(),
  styleInstructions: z.string().trim().max(4000).nullish(),
  alterationNotes: z.string().trim().max(2000).nullish(),
  measurementSetId: z.string().uuid().nullish(),
  measurementRevision: z.number().int().min(1).nullish(),
  designId: z.string().uuid().nullish(),
  pricing: pricingInputSchema.nullish(),
  priceOverrideReason: z.string().trim().max(500).nullish(),
});

const orderHeaderSchema = z.object({
  locationId: z.string().uuid(),
  promisedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  priority: ciEnum(['Low', 'Normal', 'High', 'Urgent']).default('Normal'),
  deliveryMethod: ciEnum(['Collection', 'Delivery']).default('Collection'),
  deliveryAddress: z.string().trim().max(500).nullish(),
  deliveryInstructions: z.string().trim().max(1000).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  discount: z.number().min(0).max(100_000_000).default(0),
  garments: z.array(garmentSchema).min(1).max(100),
});

const createOrderSchema = orderHeaderSchema.extend({ customerId: z.string().uuid() });
const updateOrderSchema = orderHeaderSchema.extend({
  version: z.number().int().min(0).max(4_294_967_295),
});

const fittingSchema = z.object({
  customerId: z.string().uuid(),
  locationId: z.string().uuid(),
  orderId: z.string().uuid().optional(),
  scheduledAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(480).default(30),
  notes: z.string().trim().max(2000).nullable().optional(),
});
const fittingStatusSchema = z.object({
  status: ciEnum(['Scheduled', 'Completed', 'Cancelled', 'NoShow']),
  notes: z.string().trim().max(2000).nullable().optional(),
  cancellationReason: z.string().trim().min(3).max(500).optional(),
}).superRefine((payload, context) => {
  if (payload.status === 'Cancelled' && !payload.cancellationReason) {
    context.addIssue({ code: 'custom', path: ['cancellationReason'], message: 'A cancellation reason is required.' });
  }
});
const appointmentSchema = z.object({
  type: ciEnum(['Fitting', 'Consultation', 'Collection', 'Delivery']),
  customerId: z.string().uuid(),
  locationId: z.string().uuid(),
  orderId: z.string().uuid().nullable().optional(),
  assignedMembershipId: z.string().uuid(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  notes: z.string().trim().max(2000).nullable().optional(),
}).strict();
const appointmentIntervalSchema = z.object({
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
}).strict();
const appointmentCancelSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
const appointmentStatusSchema = z.object({ status: ciEnum(['Scheduled', 'Completed', 'NoShow']) }).strict();
const appointmentListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  view: z.enum(['upcoming', 'all']).optional(),
  type: ciEnum(['Fitting', 'Consultation', 'Collection', 'Delivery']).optional(),
  status: ciEnum(['Scheduled', 'Completed', 'Cancelled', 'NoShow']).optional(),
  customerId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  assignedMembershipId: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
}).strict();

const workflowSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
  garmentCategories: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
  stages: z.array(z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    name: z.string().trim().min(2).max(80),
    instructions: z.string().trim().max(2000).nullish(),
    requiredSkill: z.string().trim().max(60).nullish(),
    defaultMinutes: z.number().int().min(1).max(1440).nullish(),
    isConditional: z.boolean().default(false),
    completionChecks: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
    dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)).max(30).optional(),
  })).min(1).max(30),
});

const materialRequirementSchema = z.object({
  name: z.string().trim().min(1).max(120),
  quantity: z.number().positive().max(1_000_000),
  unit: z.string().trim().min(1).max(20),
});

const createTaskSchema = z.object({
  title: z.string().trim().min(2).max(160),
  orderGarmentId: z.string().uuid().optional(),
  stageName: z.string().trim().max(80).optional(),
  instructions: z.string().trim().max(4000).nullish(),
  requiredSkill: z.string().trim().max(60).nullish(),
  estimatedMinutes: z.number().int().min(1).max(100_000).nullish(),
  priority: ciEnum(['Low', 'Normal', 'High', 'Urgent']).default('Normal'),
  deadline: z.string().datetime({ offset: true }).nullish(),
  completionChecks: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  requiredMaterials: z.array(materialRequirementSchema).max(100).default([]),
  dependsOnTaskIds: z.array(z.string().uuid()).max(100).default([]),
});

const updateTaskSchema = z.object({
  version: z.number().int().min(0).max(4_294_967_295),
  instructions: z.string().trim().max(4000).nullish(),
  priority: ciEnum(['Low', 'Normal', 'High', 'Urgent']).optional(),
  deadline: z.string().datetime({ offset: true }).nullish(),
  estimatedMinutes: z.number().int().min(1).max(100_000).nullish(),
  requiredSkill: z.string().trim().max(60).nullish(),
  requiredMaterials: z.array(materialRequirementSchema).max(100).optional(),
});

const assignTaskSchema = z.object({
  membershipId: z.string().uuid().nullish(),
  reason: z.string().trim().max(500).optional(),
  override: z.boolean().default(false),
});
const taskNoteSchema = z.object({ note: z.string().trim().max(1000).nullish() });
const cancelTaskSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const overrideTaskSchema = z.object({
  action: ciEnum(['Start', 'Complete']),
  reason: z.string().trim().min(5).max(500),
});
const completeTaskSchema = z.object({
  notes: z.string().trim().max(2000).nullish(),
  completedChecks: z.array(z.string().trim().max(200)).max(10).default([]),
  alterationsRequired: z.boolean().default(false),
  alterationNotes: z.string().trim().max(2000).nullish(),
});
const reportTaskIssueSchema = z.object({
  type: ciEnum(['MissingMaterials', 'Defect', 'Clarification', 'Other']),
  description: z.string().trim().min(3).max(2000),
});
const taskWorkerRequestSchema = z.object({
  type: ciEnum(['Assistance', 'Reassignment', 'Discrepancy']),
  message: z.string().trim().min(3).max(2000),
  actualMinutes: z.number().int().min(1).max(100_000).optional(),
});
const reviewTaskWorkerRequestSchema = z.object({
  status: ciEnum(['Accepted', 'Declined']),
  note: z.string().trim().max(1000).nullish(),
});
const requestAlterationsSchema = z.object({ notes: z.string().trim().min(3).max(2000) });
const taskProgressPhotoSchema = z.object({ caption: z.string().trim().max(500).nullish() });

const generateTasksSchema = z.object({
  workflowOverrides: z.record(z.string().uuid(), z.string().uuid()).optional(),
});
const setWorkerSkillsSchema = z.object({
  skills: z.array(z.string().trim().min(1).max(60)).max(30),
});
const schedulePreviewSchema = z.object({
  startUtc: z.string().datetime({ offset: true }),
  horizonDays: z.number().int().min(1).max(366).default(60),
});
const scheduleApplySchema = schedulePreviewSchema.extend({
  reason: z.string().trim().min(3).max(500),
  expectedTaskVersions: z.record(z.string().uuid(), z.number().int().min(0).max(4_294_967_295)),
  expectedSlots: z.array(z.object({
    taskId: z.string().uuid(),
    startUtc: z.string().datetime({ offset: true }),
    endUtc: z.string().datetime({ offset: true }),
    version: z.number().int().min(0).max(4_294_967_295),
  })),
});
const workerAvailabilityDaySchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  isAvailable: z.boolean(),
  opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/).nullable().optional(),
  closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/).nullable().optional(),
  capacityMinutes: z.number().int().min(0).max(1440),
});
const setWorkerAvailabilitySchema = z.object({ days: z.array(workerAvailabilityDaySchema).length(7) });
const workerLeaveSchema = z.object({
  startsAtUtc: z.string().datetime({ offset: true }),
  endsAtUtc: z.string().datetime({ offset: true }),
  reason: z.string().trim().min(2).max(300),
});
const workerLeaveReviewSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(500).nullable().optional(),
});

function validateWorkflow(payload) {
  const keys = payload.stages.map((stage) => stage.key);
  const problems = [];
  if (new Set(keys).size !== keys.length) problems.push('Stage keys must be unique.');
  if (payload.stages.every((stage) => stage.isConditional)) problems.push('At least one stage must be non-conditional.');
  const dependencies = new Map();
  payload.stages.forEach((stage, index) => {
    const deps = [...new Set(stage.dependsOn ?? (index > 0 ? [keys[index - 1]] : []))];
    if (stage.isConditional && deps.length === 0) problems.push(`Conditional stage '${stage.key}' needs at least one prerequisite.`);
    if (deps.includes(stage.key)) problems.push(`Stage '${stage.key}' cannot depend on itself.`);
    if (deps.some((key) => !keys.includes(key))) problems.push(`Stage '${stage.key}' depends on an unknown stage.`);
    dependencies.set(stage.key, deps);
  });
  const visited = new Set();
  const visiting = new Set();
  function hasCycle(key) {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    for (const dependency of dependencies.get(key) ?? []) {
      if (dependencies.has(dependency) && hasCycle(dependency)) return true;
    }
    visiting.delete(key);
    visited.add(key);
    return false;
  }
  if (problems.length === 0 && keys.some(hasCycle)) problems.push('Stage dependencies contain a cycle.');
  if (problems.length) throw AppError.badRequest('invalid_workflow', problems.join(' '));
  return dependencies;
}

function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.') || 'body', [issue.message]]));
    throw new AppError(400, 'validation_failed', 'One or more validation errors occurred.', { errors });
  }
  return result.data;
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

const clean = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const toMoney = (value) => Number(value).toFixed(2);
function decimalCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw AppError.badRequest('invalid_price', 'Money values can have at most 2 decimal places.');
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}
const formatCents = (value) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;

async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function parseAppointmentListQuery(query) {
  const payload = parse(appointmentListSchema, query);
  if (payload.from && payload.to && new Date(payload.to) <= new Date(payload.from)) {
    throw AppError.badRequest('invalid_date_range', 'The to date must be later than the from date.');
  }
  return {
    page: payload.page,
    pageSize: payload.pageSize,
    type: payload.type,
    status: payload.status,
    customerId: payload.customerId,
    orderId: payload.orderId,
    locationId: payload.locationId,
    assignedMembershipId: payload.assignedMembershipId,
    fromUtc: payload.from ? new Date(payload.from) : null,
    toUtc: payload.to ? new Date(payload.to) : null,
  };
}

/** The order list query: one page of orders with the screen's filters, inside the person's locations. Also feeds the CSV export. */
async function listOrdersPage(pool, user, allowed, query, page, pageSize) {
  const filters = ['o."BusinessId" = $1', '($2::uuid[] IS NULL OR o."LocationId" = ANY($2::uuid[]))'];
  const values = [user.businessId, allowed];
  if (!isBlank(query.status)) {
    values.push(parseEnum(String(query.status), [...ORDER_STATUSES], 'status'));
    filters.push(`o."Status" = $${values.length}`);
  }
  for (const [name, column] of [['customerId', 'CustomerId'], ['locationId', 'LocationId']]) {
    if (query[name]) {
      if (!isUuid(String(query[name]))) throw AppError.badRequest(`invalid_${name}`, `The ${name} is invalid.`);
      values.push(String(query[name]));
      filters.push(`o."${column}" = $${values.length}`);
    }
  }
  for (const [name, operator] of [['dueFrom', '>='], ['dueTo', '<=']]) {
    if (query[name]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(query[name]))) throw AppError.badRequest('invalid_due_date', 'The due date is invalid.');
      values.push(String(query[name]));
      filters.push(`o."PromisedDate" ${operator} $${values.length}::date`);
    }
  }
  if (query.search) {
    const search = `%${String(query.search).trim().slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;
    values.push(search);
    filters.push(`(o."OrderNumber" ILIKE $${values.length} ESCAPE E'\\\\' OR c."FullName" ILIKE $${values.length} ESCAPE E'\\\\')`);
  }
  const where = filters.join(' AND ');
  const count = await pool.query(`
    SELECT count(*)::int AS "TotalCount" FROM "Orders" o
    JOIN "Customers" c ON c."BusinessId" = o."BusinessId" AND c."Id" = o."CustomerId"
    WHERE ${where}`, values);
  const { rows } = await pool.query(`
    SELECT o."Id", o."OrderNumber", o."Status", o."CustomerId", c."FullName" AS "CustomerName",
      o."PromisedDate", o."Priority", o."Total", o."CurrencyCode",
      (SELECT count(*)::int FROM "OrderGarments" g WHERE g."BusinessId" = o."BusinessId" AND g."OrderId" = o."Id") AS "GarmentCount"
    FROM "Orders" o JOIN "Customers" c ON c."BusinessId" = o."BusinessId" AND c."Id" = o."CustomerId"
    WHERE ${where} ORDER BY o."PromisedDate", o."CreatedAtUtc" DESC, o."Id"
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
  [...values, pageSize, (page - 1) * pageSize]);
  return {
    items: rows.map((row) => ({
      id: row.Id, orderNumber: row.OrderNumber, status: row.Status, customerId: row.CustomerId,
      customerName: row.CustomerName, promisedDate: String(row.PromisedDate).slice(0, 10),
      priority: row.Priority, total: Number(row.Total), currencyCode: row.CurrencyCode, garmentCount: row.GarmentCount,
    })),
    page, pageSize, totalCount: Number(count.rows[0]?.TotalCount ?? 0),
  };
}

function orderListPaging(query) {
  const page = Number.parseInt(query.page ?? '1', 10);
  const pageSize = Number.parseInt(query.pageSize ?? '25', 10);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
  }
  return { page, pageSize };
}

export async function allowedLocations(pool, user) {
  if (user.isOwner || user.permissions.includes('locations.all')) return null;
  const { rows } = await pool.query(`
    SELECT DISTINCT ml."LocationId"
    FROM "Memberships" m
    JOIN "MembershipLocations" ml ON ml."MembershipId" = m."Id" AND ml."BusinessId" = m."BusinessId"
    WHERE m."UserId" = $1 AND m."BusinessId" = $2 AND m."Status" = 0`,
  [user.userId, user.businessId]);
  return rows.map((row) => row.LocationId);
}

async function ensureLocation(db, businessId, locationId, allowed) {
  if (allowed !== null && !allowed.includes(locationId)) {
    throw AppError.forbidden('location_forbidden', 'You do not have access to that location.');
  }
  const { rows } = await db.query(`
    SELECT 1 FROM "Locations" WHERE "BusinessId" = $1 AND "Id" = $2 AND "IsActive"`,
  [businessId, locationId]);
  if (!rows.length) throw AppError.badRequest('unknown_location', 'Location not found or inactive.');
}

async function auditOrder(db, req, action, orderId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'Order')`,
  [randomUUID(), action, req.currentUser.userId, req.currentUser.businessId, details ? JSON.stringify(details) : null, orderId]);
}

async function auditCalendarFeed(db, req, action, feedId, details) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'CalendarFeed')`,
  [randomUUID(), action, req.currentUser.userId, req.currentUser.businessId, JSON.stringify(details), feedId]);
}

async function consumeOrderEntitlement(db, user) {
  const key = 'orders.monthly.max';
  const { rows: entitlements } = await db.query(`
    SELECT COALESCE(override."Value", pe."Value", '0') AS "Value"
    FROM "Plans" p
    LEFT JOIN "PlanEntitlements" pe ON pe."PlanId" = p."Id" AND pe."Key" = $2
    LEFT JOIN LATERAL (
      SELECT o."Value" FROM "EntitlementOverrides" o
      WHERE o."BusinessId" = $1 AND o."Key" = $2
        AND (o."ExpiresAtUtc" IS NULL OR o."ExpiresAtUtc" > now())
      ORDER BY o."CreatedAtUtc" DESC LIMIT 1
    ) override ON TRUE
    WHERE p."Id" = COALESCE(
      (SELECT s."PlanId" FROM "Subscriptions" s WHERE s."BusinessId" = $1 AND s."Status" <> 'Expired' LIMIT 1),
      (SELECT free."Id" FROM "Plans" free WHERE free."Code" = 'free' LIMIT 1)
    )`, [user.businessId, key]);
  if (!entitlements.length) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');

  const rawLimit = String(entitlements[0].Value ?? '0').trim();
  const limit = rawLimit === 'unlimited' ? null : (/^\d+$/.test(rawLimit) ? BigInt(rawLimit) : 0n);
  const { rows: consumed } = await db.query(`
    INSERT INTO "UsageCounters" ("BusinessId", "Key", "PeriodStartUtc", "Count")
    SELECT $1, $2, date_trunc('month', now()), 1 WHERE $3::bigint IS NULL OR $3::bigint >= 1
    ON CONFLICT ("BusinessId", "Key", "PeriodStartUtc")
    DO UPDATE SET "Count" = "UsageCounters"."Count" + 1
      WHERE $3::bigint IS NULL OR "UsageCounters"."Count" + 1 <= $3::bigint
    RETURNING "Count"`, [user.businessId, key, limit === null ? null : limit.toString()]);
  if (!consumed.length) {
    const { rows: used } = await db.query(`
      SELECT "Count" FROM "UsageCounters"
      WHERE "BusinessId" = $1 AND "Key" = $2 AND "PeriodStartUtc" = date_trunc('month', now())`, [user.businessId, key]);
    const usedCount = Number(used[0]?.Count ?? 0);
    throw new AppError(403, 'plan_limit_reached', `Your plan allows ${limit} orders this month, and you have used ${usedCount}. Upgrade to unlock more.`, {
      entitlement: key, limit: Number(limit ?? 0n), used: usedCount,
    });
  }
}

export async function createOrderInTransaction(client, user, payload, idempotencyKey) {
  const req = { currentUser: user };
  const businessId = user.businessId;
  const allowed = await allowedLocations(client, user);
  if (idempotencyKey) {
    const { rows } = await client.query(`
      SELECT "Id" FROM "Orders" WHERE "BusinessId" = $1 AND "IdempotencyKey" = $2 FOR UPDATE`,
    [businessId, idempotencyKey]);
    if (rows.length) return { order: await loadOrder(client, businessId, rows[0].Id, allowed), created: false };
  }
  await ensureLocation(client, businessId, payload.locationId, allowed);
  const { rows: customers } = await client.query(`
    SELECT "Id", "Status" FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2`,
  [businessId, payload.customerId]);
  if (!customers.length) throw AppError.badRequest('unknown_customer', 'Customer not found.');
  if (customers[0].Status !== 'Active') throw AppError.conflict('customer_not_active', 'Orders can only be created for active customers.');
  const { rows: business } = await client.query(`
    SELECT "CurrencyCode", (now() AT TIME ZONE "TimeZoneId")::date::text AS "Today"
    FROM "Businesses" WHERE "Id" = $1`, [businessId]);
  if (!business.length) throw AppError.notFound('business_not_found', 'Business not found.');
  if (payload.promisedDate < business[0].Today) {
    throw AppError.badRequest('promised_date_in_past', 'The promised date cannot be in the past.');
  }
  if (payload.deliveryMethod === 'Delivery' && !clean(payload.deliveryAddress)) {
    throw AppError.badRequest('delivery_address_required', 'A delivery address is required for delivery orders.');
  }
  const lineCents = payload.garments.map((garment) => decimalCents(garment.unitPrice) * BigInt(garment.quantity));
  const subtotalCents = lineCents.reduce((total, line) => total + line, 0n);
  const discountCents = decimalCents(payload.discount);
  if (discountCents > subtotalCents) throw AppError.badRequest('discount_exceeds_total', 'The discount cannot exceed the order subtotal.');
  await consumeOrderEntitlement(client, user);
  const year = new Date().getUTCFullYear();
  const { rows: counter } = await client.query(`
    INSERT INTO "OrderCounters" ("BusinessId", "Year", "LastValue") VALUES ($1, $2, 1)
    ON CONFLICT ("BusinessId", "Year") DO UPDATE SET "LastValue" = "OrderCounters"."LastValue" + 1
    RETURNING "LastValue"`, [businessId, year]);
  const number = `ORD-${year}-${String(counter[0].LastValue).padStart(5, '0')}`;
  const orderId = randomUUID();
  await client.query(`
    INSERT INTO "Orders" ("Id", "BusinessId", "LocationId", "CustomerId", "OrderNumber", "Status", "Priority",
      "PromisedDate", "DeliveryMethod", "DeliveryAddress", "DeliveryInstructions", "Notes", "CurrencyCode",
      "Subtotal", "Discount", "Total", "IdempotencyKey", "CreatedByUserId", "CreatedAtUtc")
    VALUES ($1, $2, $3, $4, $5, 'Draft', $6, $7::date, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())`,
  [orderId, businessId, payload.locationId, payload.customerId, number, payload.priority, payload.promisedDate,
    payload.deliveryMethod, clean(payload.deliveryAddress), clean(payload.deliveryInstructions), clean(payload.notes),
    business[0].CurrencyCode, formatCents(subtotalCents), formatCents(discountCents), formatCents(subtotalCents - discountCents),
    idempotencyKey, user.userId]);
  for (let index = 0; index < payload.garments.length; index += 1) {
    await addGarment(client, req, orderId, payload.garments[index], index + 1, payload.customerId, null, lineCents[index]);
  }
  await auditOrder(client, req, 'order.created', orderId, {
    orderNumber: number, total: formatCents(subtotalCents - discountCents), currencyCode: business[0].CurrencyCode,
  });
  return { order: await loadOrder(client, businessId, orderId, allowed), created: true };
}

// regenerateGarmentIds: garment lines whose earlier tasks were cancelled by an amendment and must get a fresh set.
async function generateProductionTasks(db, businessId, orderId, actorUserId, workflowOverrides = {}, regenerateGarmentIds = new Set()) {
  const { rows: orderRows } = await db.query(`
    SELECT o."Status", o."PromisedDate", o."Priority", b."TimeZoneId"
    FROM "Orders" o JOIN "Businesses" b ON b."Id" = o."BusinessId"
    WHERE o."BusinessId" = $1 AND o."Id" = $2`,
  [businessId, orderId]);
  if (!orderRows.length) throw AppError.notFound('order_not_found', 'Order not found.');
  const order = orderRows[0];
  if (!isProductionActive(order.Status)) {
    throw AppError.conflict('order_not_active', 'Tasks can only be generated for confirmed orders in production.');
  }

  const { rows: garments } = await db.query(`
    SELECT g."Id", g."Name", g."Quantity", g."Category"
    FROM "OrderGarments" g
    WHERE g."BusinessId" = $1 AND g."OrderId" = $2 ORDER BY g."LineNumber"`,
  [businessId, orderId]);
  const { rows: plannedRows } = await db.query(`
    SELECT DISTINCT "OrderGarmentId" FROM "ProductionTasks"
    WHERE "BusinessId" = $1 AND "OrderId" = $2`,
  [businessId, orderId]);
  const alreadyPlanned = new Set(plannedRows.map((row) => row.OrderGarmentId));
  for (const garmentId of regenerateGarmentIds) alreadyPlanned.delete(garmentId);
  const { rows: workflows } = await db.query(`
    SELECT "Id", "Name", "IsDefault", "GarmentCategories" FROM "Workflows"
    WHERE "BusinessId" = $1 AND "IsActive" ORDER BY "IsDefault" DESC, "Name"`,
  [businessId]);
  const workflowIds = workflows.map((workflow) => workflow.Id);
  const { rows: stages } = workflowIds.length ? await db.query(`
    SELECT "Id", "WorkflowId", "Name", "SortOrder", "Instructions", "RequiredSkill", "DefaultMinutes",
      "IsConditional", "CompletionChecks"
    FROM "Stages" WHERE "BusinessId" = $1 AND "WorkflowId" = ANY($2::uuid[])
    ORDER BY "WorkflowId", "SortOrder"`,
  [businessId, workflowIds]) : { rows: [] };
  const { rows: stageDependencies } = workflowIds.length ? await db.query(`
    SELECT d."StageId", d."DependsOnStageId"
    FROM "StageDependencies" d
    WHERE d."BusinessId" = $1 AND d."StageId" = ANY($2::uuid[])`,
  [businessId, stages.map((stage) => stage.Id)]) : { rows: [] };

  const stagesByWorkflow = new Map();
  for (const stage of stages) {
    const workflowStages = stagesByWorkflow.get(stage.WorkflowId) ?? [];
    workflowStages.push(stage);
    stagesByWorkflow.set(stage.WorkflowId, workflowStages);
  }
  const deadlineResult = await db.query(`
    SELECT (($1::date + time '23:59') AT TIME ZONE $2) AS "DeadlineUtc"`,
  [order.PromisedDate, order.TimeZoneId]);
  const deadlineUtc = deadlineResult.rows[0].DeadlineUtc;

  let tasksCreated = 0;
  let garmentsWithoutWorkflow = 0;
  let garmentsAlreadyPlanned = 0;
  for (const garment of garments) {
    if (alreadyPlanned.has(garment.Id)) {
      garmentsAlreadyPlanned++;
      continue;
    }

    const requestedWorkflowId = workflowOverrides[garment.Id];
    const workflow = requestedWorkflowId
      ? workflows.find((candidate) => candidate.Id === requestedWorkflowId)
      : pickWorkflow(workflows, garment.Category);
    if (requestedWorkflowId && !workflow) {
      throw AppError.badRequest('unknown_workflow', 'A chosen workflow does not exist or is inactive.');
    }
    if (!workflow) {
      garmentsWithoutWorkflow++;
      continue;
    }

    const workflowStages = stagesByWorkflow.get(workflow.Id) ?? [];
    const taskIdsByStage = new Map();
    for (const stage of workflowStages) {
      const taskId = randomUUID();
      taskIdsByStage.set(stage.Id, taskId);
      const conditional = stage.IsConditional;
      await db.query(`
        INSERT INTO "ProductionTasks" (
          "Id", "BusinessId", "OrderId", "OrderGarmentId", "StageId", "StageName", "StageOrder",
          "Title", "Instructions", "Quantity", "RequiredSkill", "EstimatedMinutes", "DeadlineUtc",
          "Priority", "IsConditional", "Status", "CancelReason", "RequiredMaterialsJson", "RequiredChecks", "CompletedChecks",
          "CreatedByUserId", "CreatedAtUtc"
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, '[]'::jsonb, $18::text[], '{}'::text[], $19, now()
        )`,
      [taskId, businessId, orderId, garment.Id, stage.Id, stage.Name, stage.SortOrder,
        `${stage.Name} - ${garment.Name}`, stage.Instructions, garment.Quantity, stage.RequiredSkill,
        stage.DefaultMinutes === null ? null : stage.DefaultMinutes * garment.Quantity, deadlineUtc,
        order.Priority, conditional, conditional ? 'Cancelled' : 'Pending',
        conditional ? 'Not required (conditional step)' : null, stage.CompletionChecks ?? [], actorUserId]);
      await db.query(`
        INSERT INTO "TaskEvents" ("Id", "BusinessId", "TaskId", "Type", "FromStatus", "ToStatus", "ActorUserId", "DataJson", "CreatedAtUtc")
        VALUES ($1, $2, $3, 'generated', NULL, $4, $5, $6::jsonb, now())`,
      [randomUUID(), businessId, taskId, conditional ? 'Cancelled' : 'Pending', actorUserId,
        JSON.stringify({ workflow: workflow.Name })]);
      tasksCreated++;
    }

    for (const dependency of stageDependencies) {
      const taskId = taskIdsByStage.get(dependency.StageId);
      const dependsOnTaskId = taskIdsByStage.get(dependency.DependsOnStageId);
      if (!taskId || !dependsOnTaskId) continue;
      await db.query(`
        INSERT INTO "TaskDependencies" ("TaskId", "DependsOnTaskId", "BusinessId")
        VALUES ($1, $2, $3)`,
      [taskId, dependsOnTaskId, businessId]);
    }
  }
  return { tasksCreated, garmentsWithoutWorkflow, garmentsAlreadyPlanned };
}

async function loadWorkflow(db, businessId, id) {
  const { rows: workflowRows } = await db.query(`
    SELECT "Id", "Name", "Description", "IsDefault", "IsActive", "GarmentCategories"
    FROM "Workflows" WHERE "BusinessId" = $1 AND "Id" = $2`,
  [businessId, id]);
  if (!workflowRows.length) throw AppError.notFound('workflow_not_found', 'Workflow not found.');
  const workflow = workflowRows[0];
  const { rows: stages } = await db.query(`
    SELECT "Id", "Key", "Name", "SortOrder", "Instructions", "RequiredSkill", "DefaultMinutes",
      "IsConditional", "CompletionChecks"
    FROM "Stages" WHERE "BusinessId" = $1 AND "WorkflowId" = $2 ORDER BY "SortOrder"`,
  [businessId, id]);
  const stageIds = stages.map((stage) => stage.Id);
  const { rows: dependencyRows } = stageIds.length ? await db.query(`
    SELECT d."StageId", d."DependsOnStageId", prerequisite."Key" AS "DependsOnKey"
    FROM "StageDependencies" d
    JOIN "Stages" prerequisite ON prerequisite."BusinessId" = d."BusinessId" AND prerequisite."Id" = d."DependsOnStageId"
    WHERE d."BusinessId" = $1 AND d."StageId" = ANY($2::uuid[])`,
  [businessId, stageIds]) : { rows: [] };
  return {
    id: workflow.Id,
    name: workflow.Name,
    description: workflow.Description,
    isDefault: workflow.IsDefault,
    isActive: workflow.IsActive,
    garmentCategories: workflow.GarmentCategories ?? [],
    stages: stages.map((stage) => ({
      id: stage.Id,
      key: stage.Key,
      name: stage.Name,
      sortOrder: stage.SortOrder,
      instructions: stage.Instructions,
      requiredSkill: stage.RequiredSkill,
      defaultMinutes: stage.DefaultMinutes,
      isConditional: stage.IsConditional,
      completionChecks: stage.CompletionChecks ?? [],
      dependsOn: dependencyRows.filter((dependency) => dependency.StageId === stage.Id)
        .map((dependency) => dependency.DependsOnKey).sort(),
    })),
  };
}

async function auditWorkflow(db, req, action, workflowId, name) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'ProductionWorkflow')`,
  [randomUUID(), action, req.currentUser.userId, req.currentUser.businessId,
    JSON.stringify({ name }), workflowId]);
}

function taskSummary(row, now = new Date()) {
  const statusOpen = !['Completed', 'Cancelled'].includes(row.Status);
  const eligible = ['Pending', 'Scheduled'].includes(row.Status)
    && Number(row.UnmetDependencies) === 0
    && isProductionActive(row.OrderStatus);
  return {
    id: row.Id,
    orderId: row.OrderId,
    orderNumber: row.OrderNumber,
    orderGarmentId: row.OrderGarmentId,
    garmentName: row.GarmentName,
    stageName: row.StageName,
    stageOrder: row.StageOrder,
    title: row.Title,
    quantity: row.Quantity,
    status: row.Status,
    priority: row.Priority,
    deadlineUtc: row.DeadlineUtc,
    isOverdue: statusOpen && row.DeadlineUtc !== null && row.DeadlineUtc !== undefined
      && new Date(row.DeadlineUtc) < now,
    assigneeMembershipId: row.AssignedMembershipId,
    assigneeName: row.AssigneeName,
    requiredSkill: row.RequiredSkill,
    estimatedMinutes: row.EstimatedMinutes,
    needsEstimate: row.EstimatedMinutes === null && statusOpen,
    unmetDependencies: Number(row.UnmetDependencies),
    isEligible: eligible,
    isConditional: row.IsConditional,
    blockedType: row.BlockedType,
    blockedReason: row.BlockedReason,
    version: Number(row.Version),
  };
}

const taskSummaryColumns = `
  t."Id", t."OrderId", o."OrderNumber", o."Status" AS "OrderStatus",
  t."OrderGarmentId", g."Name" AS "GarmentName", t."StageName", t."StageOrder",
  t."Title", t."Quantity", t."Status", t."Priority", t."DeadlineUtc",
  t."AssignedMembershipId", m."DisplayName" AS "AssigneeName", t."RequiredSkill",
  t."EstimatedMinutes", t."IsConditional", t."BlockedType", t."BlockedReason",
  t.xmin::text::bigint AS "Version",
  (SELECT count(*) FROM "TaskDependencies" d
    JOIN "ProductionTasks" prerequisite ON prerequisite."BusinessId" = d."BusinessId" AND prerequisite."Id" = d."DependsOnTaskId"
    WHERE d."BusinessId" = t."BusinessId" AND d."TaskId" = t."Id"
      AND prerequisite."Status" NOT IN ('Completed', 'Cancelled')) AS "UnmetDependencies"`;

async function loadTaskSummary(db, businessId, taskId, allowed) {
  const { rows } = await db.query(`
    SELECT ${taskSummaryColumns}
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    JOIN "OrderGarments" g ON g."BusinessId" = t."BusinessId" AND g."Id" = t."OrderGarmentId"
    LEFT JOIN "Memberships" m ON m."BusinessId" = t."BusinessId" AND m."Id" = t."AssignedMembershipId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2
      AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))`,
  [businessId, taskId, allowed]);
  if (!rows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  return rows[0];
}

export async function loadTaskDetail(db, businessId, taskId, allowed, includeCustomer = true) {
  const row = await loadTaskSummary(db, businessId, taskId, allowed);
  const { rows: taskRows } = await db.query(`
    SELECT t."Instructions", t."RequiredChecks", t."CompletedChecks", t."RequiredMaterialsJson",
      t."CompletionNotes", t."PlannedStartUtc", t."PlannedEndUtc", t."ActualStartUtc", t."CompletedAtUtc",
      g."Name" AS "GarmentName", g."Category", g."Quantity" AS "GarmentQuantity", g."Fabric", g."Colour",
      g."StyleInstructions", g."AlterationNotes", g."MeasurementSnapshotJson",
      ${includeCustomer ? 'c."FullName" AS "CustomerName"' : 'NULL::text AS "CustomerName"'}
    FROM "ProductionTasks" t
    JOIN "OrderGarments" g ON g."BusinessId" = t."BusinessId" AND g."Id" = t."OrderGarmentId"
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    ${includeCustomer ? 'JOIN "Customers" c ON c."BusinessId" = o."BusinessId" AND c."Id" = o."CustomerId"' : ''}
    WHERE t."BusinessId" = $1 AND t."Id" = $2 AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))`,
  [businessId, taskId, allowed]);
  if (!taskRows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  const task = taskRows[0];
  const [dependencies, events] = await Promise.all([
    db.query(`
      SELECT prerequisite."Id", prerequisite."Title", prerequisite."Status"
      FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite
        ON prerequisite."BusinessId" = d."BusinessId" AND prerequisite."Id" = d."DependsOnTaskId"
      WHERE d."BusinessId" = $1 AND d."TaskId" = $2 ORDER BY prerequisite."StageOrder"`,
    [businessId, taskId]),
    db.query(`
      SELECT "Type", "FromStatus", "ToStatus", "ActorUserId", "Note", "CreatedAtUtc"
      FROM "TaskEvents" WHERE "BusinessId" = $1 AND "TaskId" = $2
      ORDER BY "CreatedAtUtc" DESC LIMIT 100`,
    [businessId, taskId]),
  ]);
  const requiredMaterials = typeof task.RequiredMaterialsJson === 'string'
    ? JSON.parse(task.RequiredMaterialsJson) : task.RequiredMaterialsJson;
  return {
    task: taskSummary(row),
    instructions: task.Instructions,
    requiredChecks: task.RequiredChecks ?? [],
    completedChecks: task.CompletedChecks ?? [],
    requiredMaterials: requiredMaterials ?? [],
    completionNotes: task.CompletionNotes,
    plannedStartUtc: task.PlannedStartUtc,
    plannedEndUtc: task.PlannedEndUtc,
    actualStartUtc: task.ActualStartUtc,
    completedAtUtc: task.CompletedAtUtc,
    dependsOn: dependencies.rows.map((dependency) => ({
      taskId: dependency.Id, title: dependency.Title, status: dependency.Status,
    })),
    garment: {
      name: task.GarmentName,
      category: task.Category,
      quantity: task.GarmentQuantity,
      fabric: task.Fabric,
      colour: task.Colour,
      styleInstructions: task.StyleInstructions,
      alterationNotes: task.AlterationNotes,
      measurementSnapshot: typeof task.MeasurementSnapshotJson === 'string'
        ? JSON.parse(task.MeasurementSnapshotJson) : task.MeasurementSnapshotJson,
    },
    customerName: task.CustomerName,
    events: events.rows.map((event) => ({
      type: event.Type, fromStatus: event.FromStatus, toStatus: event.ToStatus,
      actorUserId: event.ActorUserId, note: event.Note, atUtc: event.CreatedAtUtc,
    })),
  };
}

async function recordTaskEvent(db, businessId, taskId, type, fromStatus, toStatus, actorUserId, note = null, data = null) {
  await db.query(`
    INSERT INTO "TaskEvents" ("Id", "BusinessId", "TaskId", "Type", "FromStatus", "ToStatus",
      "ActorUserId", "Note", "DataJson", "CreatedAtUtc")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())`,
  [randomUUID(), businessId, taskId, type, fromStatus, toStatus, actorUserId, clean(note),
    data === null ? null : JSON.stringify(data)]);
}

async function auditTask(db, req, action, taskId, details) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc",
      "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'ProductionTask')`,
  [randomUUID(), action, req.currentUser.userId, req.currentUser.businessId,
    JSON.stringify(details), taskId]);
}

async function syncOrderFromTasks(db, businessId, orderId) {
  const { rows: orderRows } = await db.query(`
    SELECT "Status" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2 FOR UPDATE`,
  [businessId, orderId]);
  if (!orderRows.length || !isProductionOpen(orderRows[0].Status)) return;
  const { rows } = await db.query(`
    SELECT "Status" FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" <> 'Cancelled'`,
  [businessId, orderId]);
  if (!rows.length) return;
  const allDone = rows.every((task) => task.Status === 'Completed');
  const started = rows.some((task) => ['InProgress', 'Paused', 'Completed'].includes(task.Status));
  if (allDone && canTransition(orderRows[0].Status, 'Ready')) {
    const { rows: ready } = await db.query(`
      UPDATE "Orders" SET "Status" = 'Ready', "ReadyAtUtc" = now(), "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $1 AND "Id" = $2
      RETURNING "CustomerId", "ReadyAtUtc"`,
    [businessId, orderId]);
    // Step 16b: an order that becomes Ready again after a reopened task has a new ReadyAtUtc, so the customer is told again.
    if (ready?.[0]) {
      await queueCustomerEvent(db, {
        businessId, customerId: ready[0].CustomerId, kind: 'order.ready', subjectId: orderId,
        dedupeKey: `order.ready:${orderId}:${new Date(ready[0].ReadyAtUtc).toISOString()}`,
      });
    }
  } else if (!allDone && orderRows[0].Status === 'Ready') {
    await db.query(`
      UPDATE "Orders" SET "Status" = 'InProduction', "ReadyAtUtc" = NULL, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $1 AND "Id" = $2`,
    [businessId, orderId]);
  } else if (!allDone && started && orderRows[0].Status === 'Confirmed') {
    await db.query(`
      UPDATE "Orders" SET "Status" = 'InProduction', "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $1 AND "Id" = $2`,
    [businessId, orderId]);
  }
}

async function createProductionTask(db, req, orderId, payload, allowed) {
  const businessId = req.currentUser.businessId;
  const { rows: orderRows } = await db.query(`
    SELECT o."Id", o."Status", o."PromisedDate", o."Priority", o."LocationId", b."TimeZoneId"
    FROM "Orders" o JOIN "Businesses" b ON b."Id" = o."BusinessId"
    WHERE o."BusinessId" = $1 AND o."Id" = $2
      AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
    FOR UPDATE OF o`,
  [businessId, orderId, allowed]);
  if (!orderRows.length) throw AppError.notFound('order_not_found', 'Order not found.');
  const order = orderRows[0];
  if (!isProductionOpen(order.Status)) {
    throw AppError.conflict('order_not_active', 'Tasks can only be added to confirmed orders that are not yet delivered.');
  }

  const { rows: garments } = await db.query(`
    SELECT "Id", "Quantity" FROM "OrderGarments"
    WHERE "BusinessId" = $1 AND "OrderId" = $2 ORDER BY "LineNumber"`,
  [businessId, orderId]);
  const garmentId = payload.orderGarmentId ?? (garments.length === 1 ? garments[0].Id : null);
  if (!garmentId) throw AppError.badRequest('garment_required', 'Choose which garment this task is for.');
  const garment = garments.find((row) => row.Id === garmentId);
  if (!garment) throw AppError.badRequest('unknown_garment', 'That garment does not belong to this order.');

  const dependencyIds = [...new Set(payload.dependsOnTaskIds)];
  if (dependencyIds.length) {
    const { rows: dependencies } = await db.query(`
      SELECT "Id" FROM "ProductionTasks"
      WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Id" = ANY($3::uuid[])`,
    [businessId, orderId, dependencyIds]);
    if (dependencies.length !== dependencyIds.length) {
      throw AppError.badRequest('unknown_dependency', 'Every prerequisite must be a task of the same order.');
    }
  }
  const { rows: deadlineRows } = await db.query(`
    SELECT (($1::date + time '23:59') AT TIME ZONE $2) AS "DeadlineUtc"`,
  [order.PromisedDate, order.TimeZoneId]);
  const taskId = randomUUID();
  const priority = payload.priority ?? order.Priority;
  const deadline = payload.deadline ?? deadlineRows[0].DeadlineUtc;
  const requiredSkill = clean(payload.requiredSkill)?.toLowerCase() ?? null;
  const requiredMaterials = payload.requiredMaterials.map((material) => ({
    name: material.name.trim(), quantity: material.quantity, unit: material.unit.trim(),
  }));
  await db.query(`
    INSERT INTO "ProductionTasks" (
      "Id", "BusinessId", "OrderId", "OrderGarmentId", "StageName", "StageOrder", "Title", "Instructions",
      "Quantity", "RequiredSkill", "EstimatedMinutes", "DeadlineUtc", "Priority", "Status", "IsConditional",
      "RequiredChecks", "CompletedChecks", "RequiredMaterialsJson", "CreatedByUserId", "CreatedAtUtc"
    ) VALUES ($1, $2, $3, $4, $5, 1000, $6, $7, $8, $9, $10, $11, $12, 'Pending', FALSE,
      $13::text[], '{}'::text[], $14::jsonb, $15, now())`,
  [taskId, businessId, orderId, garmentId, clean(payload.stageName) ?? 'Additional work',
    payload.title, clean(payload.instructions), garment.Quantity, requiredSkill, payload.estimatedMinutes ?? null,
    deadline, priority, payload.completionChecks, JSON.stringify(requiredMaterials), req.currentUser.userId]);
  for (const dependencyId of dependencyIds) {
    await db.query(`
      INSERT INTO "TaskDependencies" ("TaskId", "DependsOnTaskId", "BusinessId")
      VALUES ($1, $2, $3)`,
    [taskId, dependencyId, businessId]);
  }
  await recordTaskEvent(db, businessId, taskId, 'created', null, 'Pending', req.currentUser.userId);
  await auditTask(db, req, 'task.created', taskId, { orderId, title: payload.title });
  await syncOrderFromTasks(db, businessId, orderId);
  return taskId;
}

async function updateProductionTask(db, req, taskId, payload, allowed) {
  const businessId = req.currentUser.businessId;
  const { rows } = await db.query(`
    SELECT t."OrderId", t."Status", t."Instructions", t."Priority", t."DeadlineUtc", t."EstimatedMinutes",
      t."RequiredSkill", t."RequiredMaterialsJson"
    FROM "ProductionTasks" t JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2
      AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
    FOR UPDATE OF t`,
  [businessId, taskId, allowed]);
  if (!rows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  const task = rows[0];
  if (['Completed', 'Cancelled'].includes(task.Status)) {
    throw AppError.conflict('task_closed', `This task is ${task.Status} and can no longer be changed.`);
  }

  const updates = [];
  const values = [businessId, taskId, payload.version, req.currentUser.userId];
  const set = (column, value) => {
    values.push(value);
    updates.push(`"${column}" = $${values.length}`);
  };
  const changed = [];
  if (payload.instructions !== undefined && payload.instructions !== null && payload.instructions !== task.Instructions) {
    set('Instructions', clean(payload.instructions));
    changed.push('instructions');
  }
  if (payload.priority !== undefined && payload.priority !== task.Priority) {
    set('Priority', payload.priority);
    changed.push('priority');
  }
  if (payload.deadline !== undefined && payload.deadline !== null
      && new Date(payload.deadline).getTime() !== new Date(task.DeadlineUtc).getTime()) {
    set('DeadlineUtc', payload.deadline);
    changed.push('deadline');
  }
  if (payload.estimatedMinutes !== undefined && payload.estimatedMinutes !== null
      && payload.estimatedMinutes !== task.EstimatedMinutes) {
    set('EstimatedMinutes', payload.estimatedMinutes);
    changed.push('estimate');
  }
  if (payload.requiredSkill !== undefined && payload.requiredSkill !== null) {
    const skill = clean(payload.requiredSkill)?.toLowerCase() ?? null;
    if (skill !== task.RequiredSkill) {
      set('RequiredSkill', skill);
      changed.push('skill');
    }
  }
  if (payload.requiredMaterials !== undefined) {
    const materials = payload.requiredMaterials.map((material) => ({
      name: material.name.trim(), quantity: material.quantity, unit: material.unit.trim(),
    }));
    const current = typeof task.RequiredMaterialsJson === 'string'
      ? JSON.parse(task.RequiredMaterialsJson) : task.RequiredMaterialsJson;
    if (JSON.stringify(materials) !== JSON.stringify(current)) {
      values.push(JSON.stringify(materials));
      updates.push(`"RequiredMaterialsJson" = $${values.length}::jsonb`);
      changed.push('materials');
    }
  }
  updates.push('"UpdatedByUserId" = $4', '"UpdatedAtUtc" = now()');
  const { rowCount } = await db.query(`
    UPDATE "ProductionTasks" SET ${updates.join(', ')}
    WHERE "BusinessId" = $1 AND "Id" = $2 AND xmin = $3::xid`,
  values);
  if (!rowCount) throw AppError.conflict('stale_version', 'This task was changed by someone else. Reload and try again.');
  await recordTaskEvent(db, businessId, taskId, 'updated', task.Status, task.Status,
    req.currentUser.userId, null, { changed });
  await auditTask(db, req, 'task.updated', taskId, { changed });
  await syncOrderFromTasks(db, businessId, task.OrderId);
  return task.OrderId;
}

async function queueTaskNotification(db, { businessId, taskId, membershipId, version, templateKey, subject, message, title, body, actorUserId }) {
  const taskKey = String(taskId).replaceAll('-', '').toLowerCase();
  const memberKey = String(membershipId).replaceAll('-', '').toLowerCase();
  await notify(db, {
    businessId, category: 'tasks', eventType: templateKey, title, body,
    dedupeKey: `${templateKey}:${taskKey}:${version}`,
    target: { kind: 'task', id: taskId },
    recipients: { membershipIds: [membershipId] },
    actorUserId,
    email: {
      templateKey, subject,
      text: (recipient) => `Hello ${String(recipient.DisplayName ?? '')},\n\n${message}\n\nPlease open Avzar to view the task details.`,
      dedupeKey: () => `${templateKey}:${taskKey}:${memberKey}:${version}`,
    },
  });
}

async function queueTaskAssignmentNotification(db, businessId, taskId, membershipId, version, title, actorUserId) {
  await queueTaskNotification(db, {
    businessId, taskId, membershipId, version, actorUserId,
    templateKey: 'task.assignment', subject: 'A production task has been assigned to you',
    message: 'A production task has been assigned to you.',
    title: 'Task assigned', body: 'A production task has been assigned to you.',
  });
}

async function queueTaskUnblockedNotification(db, businessId, taskId, membershipId, version, title, actorUserId) {
  await queueTaskNotification(db, {
    businessId, taskId, membershipId, version, actorUserId,
    templateKey: 'task.unblocked', subject: 'A blocked production task is ready for review',
    message: 'A production task has been unblocked and is ready for review.',
    title: 'Task unblocked', body: 'A production task is ready to resume.',
  });
}

async function queueTaskNextStepNotifications(db, businessId, taskIds, actorUserId) {
  if (!taskIds.length) return;
  const { rows } = await db.query(`
    SELECT task."Id", task."Title", task."AssignedMembershipId", task.xmin::text::bigint AS "Version",
      membership."DisplayName", appUser."Email"
    FROM "ProductionTasks" task
    JOIN "Memberships" membership ON membership."Id" = task."AssignedMembershipId"
      AND membership."BusinessId" = task."BusinessId" AND membership."Status" = 0
    JOIN "AspNetUsers" appUser ON appUser."Id" = membership."UserId"
    WHERE task."BusinessId" = $1 AND task."Id" = ANY($2::uuid[])
      AND task."Status" IN ('Pending', 'Scheduled')`,
  [businessId, taskIds]);
  for (const task of rows) {
    await queueTaskNotification(db, {
      businessId, taskId: task.Id, membershipId: task.AssignedMembershipId, version: task.Version, actorUserId,
      templateKey: 'task.next-step-ready', subject: 'Your next production step is ready',
      message: 'Your next production step is ready to start.',
      title: 'Next task ready', body: 'Your next production step is ready to start.',
    });
  }
}

async function queueTaskIssueNotifications(db, businessId, taskId, version, title, reason, actorUserId) {
  const { rows: recipients } = await db.query(`
    SELECT DISTINCT membership."Id", membership."DisplayName", appUser."Email"
    FROM "Memberships" membership
    JOIN "AspNetUsers" appUser ON appUser."Id" = membership."UserId"
    WHERE membership."BusinessId" = $1 AND membership."Status" = 0
      AND (membership."IsOwner" = TRUE OR EXISTS (
        SELECT 1 FROM "MembershipRoles" membershipRole
        JOIN "RolePermissions" rolePermission ON rolePermission."RoleId" = membershipRole."RoleId"
        WHERE membershipRole."BusinessId" = membership."BusinessId"
          AND membershipRole."MembershipId" = membership."Id"
          AND rolePermission."Permission" = 'tasks.manage'
      ))`, [businessId]);
  for (const recipient of recipients) {
    await queueTaskNotification(db, {
      businessId, taskId, membershipId: recipient.Id, version, actorUserId,
      templateKey: 'task.issue', subject: 'A production task needs attention',
      message: 'A production task has been blocked. Please open Avzar to review the issue.',
      title: 'Task blocked', body: 'A production task is blocked and needs attention.',
    });
  }
}

async function assignProductionTask(db, req, taskId, payload, allowed) {
  const businessId = req.currentUser.businessId;
  const { rows: taskRows } = await db.query(`
    SELECT t."OrderId", t."Status", t."AssignedMembershipId", t."RequiredSkill", t."Title",
      t.xmin::text::bigint AS "Version", o."LocationId"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2
      AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
    FOR UPDATE OF t`,
  [businessId, taskId, allowed]);
  if (!taskRows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  const task = taskRows[0];
  if (['Completed', 'Cancelled', 'InProgress'].includes(task.Status)) {
    throw AppError.conflict('task_not_assignable', `A ${task.Status} task cannot be reassigned. Pause it first if it is in progress.`);
  }
  const membershipId = payload.membershipId ?? null;
  if (membershipId === task.AssignedMembershipId) {
    return;
  }

  let member = null;
  const problems = [];
  if (membershipId) {
    const { rows: members } = await db.query(`
      SELECT m."Id", m."DisplayName"
      FROM "Memberships" m
      WHERE m."BusinessId" = $1 AND m."Id" = $2 AND m."Status" = 0
        AND ($3::uuid[] IS NULL OR EXISTS (
          SELECT 1 FROM "MembershipLocations" ml
          WHERE ml."BusinessId" = m."BusinessId" AND ml."MembershipId" = m."Id"
            AND ml."LocationId" = ANY($3::uuid[])
        ))`,
    [businessId, membershipId, allowed]);
    if (!members.length) {
      throw AppError.badRequest('unknown_worker', 'That person is not an active member in your permitted workshop locations.');
    }
    member = members[0];
    if (task.RequiredSkill) {
      const { rows: skills } = await db.query(`
        SELECT 1 FROM "WorkerSkills" WHERE "BusinessId" = $1 AND "MembershipId" = $2 AND "Skill" = $3`,
      [businessId, membershipId, task.RequiredSkill]);
      if (!skills.length) problems.push(`${member.DisplayName} does not have the '${task.RequiredSkill}' skill.`);
    }
    const { rows: locationRows } = await db.query(`
      SELECT 1 FROM "MembershipLocations"
      WHERE "BusinessId" = $1 AND "MembershipId" = $2 AND "LocationId" = $3`,
    [businessId, membershipId, task.LocationId]);
    if (!locationRows.length) problems.push(`${member.DisplayName} is not assigned to this order's workshop.`);
  }

  let overridden = false;
  if (problems.length) {
    if (!payload.override) {
      throw AppError.conflict('assignment_not_allowed',
        `${problems.join(' ')} An authorised manager can override this with a reason.`,
        { problems });
    }
    if (!req.currentUser.isOwner && !req.currentUser.permissions.includes('tasks.override')) {
      throw AppError.forbidden('override_not_permitted', 'You do not have permission to override workflow rules.');
    }
    if (!payload.reason || payload.reason.trim().length < 5) {
      throw AppError.badRequest('reason_required', 'Give a reason (at least 5 characters) for the override.');
    }
    overridden = true;
  }

  const { rows: updated } = await db.query(`
    UPDATE "ProductionTasks" SET "AssignedMembershipId" = $1, "UpdatedByUserId" = $2, "UpdatedAtUtc" = now()
    WHERE "BusinessId" = $3 AND "Id" = $4
    RETURNING xmin::text::bigint AS "Version"`,
  [membershipId, req.currentUser.userId, businessId, taskId]);
  await recordTaskEvent(db, businessId, taskId, overridden ? 'override.assign' : membershipId ? 'assigned' : 'unassigned',
    task.Status, task.Status, req.currentUser.userId, payload.reason ?? null,
    { before: task.AssignedMembershipId, after: membershipId, problems });
  if (overridden) {
    await auditTask(db, req, 'task.override_assign', taskId, { reason: payload.reason, problems });
  }
  if (membershipId) {
    await queueTaskAssignmentNotification(db, businessId, taskId, membershipId, updated[0]?.Version ?? task.Version, task.Title, req.currentUser.userId);
  }
  if (task.AssignedMembershipId) {
    await queueTaskNotification(db, {
      businessId, taskId, membershipId: task.AssignedMembershipId, version: updated[0]?.Version ?? task.Version,
      actorUserId: req.currentUser.userId, templateKey: 'task.reassigned', subject: 'A production task was reassigned',
      message: 'A production task was reassigned to another worker.',
      title: 'Task reassigned', body: 'A production task is no longer assigned to you.',
    });
  }
  await syncOrderFromTasks(db, businessId, task.OrderId);
}

async function transitionProductionTask(db, req, taskId, action, payload, allowed) {
  const businessId = req.currentUser.businessId;
  const { rows } = await db.query(`
    SELECT t."OrderId", t."Status", t."StatusBeforeBlock", t."ActualStartUtc", t."Title",
      t."BlockedType", t."AssignedMembershipId", o."Status" AS "OrderStatus"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2
      AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
    FOR UPDATE OF t`,
  [businessId, taskId, allowed]);
  if (!rows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  const task = rows[0];
  const actorId = req.currentUser.userId;

  if (action === 'unblock') {
    if (task.Status !== 'Blocked') throw AppError.conflict('invalid_transition', 'Only blocked tasks can be unblocked.');
    const back = task.StatusBeforeBlock === 'InProgress' || task.ActualStartUtc ? 'Paused' : 'Pending';
    const { rows: updated } = await db.query(`
      UPDATE "ProductionTasks" SET "Status" = $1, "StatusBeforeBlock" = NULL, "BlockedType" = NULL,
        "BlockedReason" = NULL, "UpdatedByUserId" = $2, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $3 AND "Id" = $4
      RETURNING xmin::text::bigint AS "Version"`,
    [back, actorId, businessId, taskId]);
    await recordTaskEvent(db, businessId, taskId, 'unblocked', 'Blocked', back, actorId,
      payload.note ?? null, { issue: task.BlockedType });
    if (task.AssignedMembershipId) {
      await queueTaskUnblockedNotification(db, businessId, taskId, task.AssignedMembershipId, updated[0]?.Version, task.Title,
        req.currentUser.userId);
    }
  } else if (action === 'cancel') {
    if (['Completed', 'Cancelled'].includes(task.Status)) {
      throw AppError.conflict('task_closed', `This task is ${task.Status} and can no longer be changed.`);
    }
    await db.query(`
      UPDATE "ProductionTasks" SET "Status" = 'Cancelled', "CancelReason" = $1,
        "UpdatedByUserId" = $2, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $3 AND "Id" = $4`,
    [payload.reason, actorId, businessId, taskId]);
    await recordTaskEvent(db, businessId, taskId, 'cancelled', task.Status, 'Cancelled', actorId, payload.reason);
    await auditTask(db, req, 'task.cancelled', taskId, { reason: payload.reason });
  } else {
    if (['Completed', 'Cancelled'].includes(task.Status)) {
      throw AppError.conflict('task_closed', `This task is ${task.Status} and can no longer be changed.`);
    }
    if (!task.AssignedMembershipId) {
      throw AppError.conflict('assignee_required', 'Assign the task to someone first so the work is attributed correctly.');
    }
    if (!isProductionOpen(task.OrderStatus)) {
      throw AppError.conflict('order_not_active', 'This order is no longer in production.');
    }
    const nextStatus = payload.action === 'Start' ? 'InProgress' : 'Completed';
    const eventType = payload.action === 'Start' ? 'override.start' : 'override.complete';
    if (payload.action === 'Start') {
      await db.query(`
        UPDATE "ProductionTasks" SET "Status" = 'InProgress', "ActualStartUtc" = COALESCE("ActualStartUtc", now()),
          "StatusBeforeBlock" = NULL, "BlockedType" = NULL, "BlockedReason" = NULL,
          "UpdatedByUserId" = $1, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $2 AND "Id" = $3`,
      [actorId, businessId, taskId]);
    } else {
      await db.query(`
        UPDATE "ProductionTasks" SET "Status" = 'Completed', "CompletedAtUtc" = now(),
          "CompletionNotes" = $1, "UpdatedByUserId" = $2, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $3 AND "Id" = $4`,
      [`Completed by manager override: ${payload.reason}`, actorId, businessId, taskId]);
    }
    await recordTaskEvent(db, businessId, taskId, eventType, task.Status, nextStatus, actorId, payload.reason);
    await auditTask(db, req, `task.${eventType}`, taskId, { reason: payload.reason, previousStatus: task.Status });
  }
  await syncOrderFromTasks(db, businessId, task.OrderId);
}

async function workerTaskAction(db, req, taskId, action, payload = {}) {
  const businessId = req.currentUser.businessId;
  const { rows: memberships } = await db.query(`
    SELECT "Id" FROM "Memberships"
    WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0
    FOR UPDATE`,
  [businessId, req.currentUser.userId]);
  if (!memberships.length) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
  const membershipId = memberships[0].Id;
  const { rows } = await db.query(`
    SELECT t."Id", t."OrderId", t."Status", t."ActualStartUtc", o."Status" AS "OrderStatus"
    FROM "ProductionTasks" t
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE t."BusinessId" = $1 AND t."Id" = $2 AND t."AssignedMembershipId" = $3
    FOR UPDATE OF t`,
  [businessId, taskId, membershipId]);
  if (!rows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  const task = rows[0];

  let nextStatus;
  let eventType;
  let note = null;
  if (action === 'start' || action === 'resume') {
    const expectedStatus = action === 'start' ? ['Pending', 'Scheduled'] : ['Paused'];
    if (!expectedStatus.includes(task.Status)) {
      const message = action === 'start'
        ? `A ${task.Status} task cannot be started.`
        : 'Only a paused task can be resumed.';
      throw AppError.conflict('invalid_transition', message);
    }
    if (!isProductionActive(task.OrderStatus)) {
      throw AppError.conflict('order_not_active', 'This order is not in production.');
    }
    const { rows: blockers } = await db.query(`
      SELECT prerequisite."Title"
      FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite
        ON prerequisite."BusinessId" = d."BusinessId" AND prerequisite."Id" = d."DependsOnTaskId"
      WHERE d."BusinessId" = $1 AND d."TaskId" = $2
        AND prerequisite."Status" NOT IN ('Completed', 'Cancelled')
      ORDER BY prerequisite."StageOrder"`,
    [businessId, taskId]);
    if (action === 'start' && blockers.length) {
      const titles = blockers.map((blocker) => blocker.Title);
      throw AppError.conflict('dependencies_incomplete', `Waiting for: ${titles.join(', ')}.`, { blockedBy: titles });
    }
    const { rows: activeTasks } = await db.query(`
      SELECT 1 FROM "ProductionTasks"
      WHERE "BusinessId" = $1 AND "AssignedMembershipId" = $2 AND "Status" = 'InProgress' AND "Id" <> $3
      LIMIT 1`,
    [businessId, membershipId, taskId]);
    if (activeTasks.length) throw AppError.conflict('task_in_progress', 'Pause or finish the task you are working on first.');
    nextStatus = 'InProgress';
    eventType = action === 'start' ? 'started' : 'resumed';
  } else {
    if (task.Status !== 'InProgress') {
      throw AppError.conflict('invalid_transition', 'Only a task in progress can be paused.');
    }
    nextStatus = 'Paused';
    eventType = 'paused';
    note = clean(payload.note);
  }

  await db.query(`
    UPDATE "ProductionTasks" SET "Status" = $1,
      "ActualStartUtc" = CASE WHEN $1 = 'InProgress' THEN COALESCE("ActualStartUtc", now()) ELSE "ActualStartUtc" END,
      "UpdatedByUserId" = $2, "UpdatedAtUtc" = now()
    WHERE "BusinessId" = $3 AND "Id" = $4`,
  [nextStatus, req.currentUser.userId, businessId, taskId]);
  await recordTaskEvent(db, businessId, taskId, eventType, task.Status, nextStatus,
    req.currentUser.userId, note);
  await syncOrderFromTasks(db, businessId, task.OrderId);
}

async function workerTaskCompletion(db, req, taskId, payload) {
  const businessId = req.currentUser.businessId;
  const { rows: membershipRows } = await db.query(`
    SELECT "Id" FROM "Memberships"
    WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0`,
  [businessId, req.currentUser.userId]);
  if (!membershipRows.length) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
  const { rows: taskRows } = await db.query(`
    SELECT t."Id", t."OrderId", t."OrderGarmentId", t."Status", t."RequiredChecks"
    FROM "ProductionTasks" t
    WHERE t."BusinessId" = $1 AND t."Id" = $2 AND t."AssignedMembershipId" = $3
    FOR UPDATE`,
  [businessId, taskId, membershipRows[0].Id]);
  if (!taskRows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  const task = taskRows[0];
  if (task.Status !== 'InProgress') {
    throw AppError.conflict('invalid_transition', 'Start the task before completing it.');
  }

  const completedChecks = new Set(payload.completedChecks.map((check) => check.trim().toLowerCase()));
  const requiredChecks = task.RequiredChecks ?? [];
  const missing = requiredChecks.filter((check) => !completedChecks.has(check.toLowerCase()));
  if (missing.length) {
    throw AppError.badRequest('checks_incomplete', `Tick every checklist item first. Missing: ${missing.join('; ')}.`);
  }

  let activated = [];
  if (payload.alterationsRequired) {
    const { rows: conditionalDependents } = await db.query(`
      SELECT conditional."Id"
      FROM "TaskDependencies" d
      JOIN "ProductionTasks" conditional ON conditional."BusinessId" = d."BusinessId"
        AND conditional."Id" = d."TaskId" AND conditional."IsConditional"
      WHERE d."BusinessId" = $1 AND d."DependsOnTaskId" = $2`,
    [businessId, taskId]);
    if (!conditionalDependents.length) {
      throw AppError.badRequest('alterations_not_applicable', 'Alterations can only be requested from the step before them (e.g. the fitting).');
    }
    const { rows: conditionalTasks } = await db.query(`
      SELECT "Id" FROM "ProductionTasks"
      WHERE "BusinessId" = $1 AND "OrderGarmentId" = $2 AND "IsConditional"
        AND "Status" = 'Cancelled' AND "CancelReason" = 'Not required (conditional step)'
      FOR UPDATE`,
    [businessId, task.OrderGarmentId]);
    if (!conditionalTasks.length) {
      throw AppError.conflict('no_conditional_steps', 'This garment has no alteration step to activate (it was already requested, or its workflow has none).');
    }
    activated = conditionalTasks.map((row) => row.Id);
    await db.query(`
      UPDATE "ProductionTasks" SET "Status" = 'Pending', "CancelReason" = NULL,
        "UpdatedByUserId" = $1, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $2 AND "Id" = ANY($3::uuid[])`,
    [req.currentUser.userId, businessId, activated]);
    for (const activatedId of activated) {
      await recordTaskEvent(db, businessId, activatedId, 'alterations_requested',
        'Cancelled', 'Pending', req.currentUser.userId, payload.alterationNotes ?? payload.notes);
    }
  }

  const { rows: dependentRows } = await db.query(`
    SELECT DISTINCT t."Id", t."Status"
    FROM "TaskDependencies" d JOIN "ProductionTasks" t
      ON t."BusinessId" = d."BusinessId" AND t."Id" = d."TaskId"
    WHERE d."BusinessId" = $1 AND d."DependsOnTaskId" = $2
      AND t."Status" IN ('Pending', 'Scheduled')
      AND NOT (t."Id" = ANY($3::uuid[]))`,
  [businessId, taskId, activated]);
  const newlyEligible = [];
  for (const dependent of dependentRows) {
    const { rows: unmet } = await db.query(`
      SELECT 1 FROM "TaskDependencies" d
      JOIN "ProductionTasks" prerequisite ON prerequisite."BusinessId" = d."BusinessId"
        AND prerequisite."Id" = d."DependsOnTaskId"
      WHERE d."BusinessId" = $1 AND d."TaskId" = $2
        AND d."DependsOnTaskId" <> $3
        AND (prerequisite."Status" NOT IN ('Completed', 'Cancelled') OR d."DependsOnTaskId" = ANY($4::uuid[]))
      LIMIT 1`,
    [businessId, dependent.Id, taskId, activated]);
    if (!unmet.length) newlyEligible.push(dependent.Id);
  }
  newlyEligible.push(...activated);

  await db.query(`
    UPDATE "ProductionTasks" SET "Status" = 'Completed', "CompletedAtUtc" = now(),
      "CompletedChecks" = "RequiredChecks", "CompletionNotes" = $1,
      "UpdatedByUserId" = $2, "UpdatedAtUtc" = now()
    WHERE "BusinessId" = $3 AND "Id" = $4`,
  [clean(payload.notes), req.currentUser.userId, businessId, taskId]);
  if (payload.alterationsRequired) {
    const notes = clean(payload.alterationNotes) ?? clean(payload.notes);
    if (notes) {
      await db.query(`
        UPDATE "OrderGarments" SET "AlterationNotes" = left(
          CASE WHEN COALESCE("AlterationNotes", '') = '' THEN $1
            ELSE "AlterationNotes" || E'\\n' || $1 END, 2000),
          "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $2 AND "Id" = $3`,
      [`[Alterations ${new Date().toISOString().slice(0, 10)}] ${notes}`, businessId, task.OrderGarmentId]);
    }
  }
  await recordTaskEvent(db, businessId, taskId, 'completed', 'InProgress', 'Completed',
    req.currentUser.userId, clean(payload.notes), { newlyEligible, alterationsRequested: payload.alterationsRequired });
  await queueTaskNextStepNotifications(db, businessId, newlyEligible, req.currentUser.userId);
  await syncOrderFromTasks(db, businessId, task.OrderId);
}

async function workerTaskIssue(db, req, taskId, payload) {
  const businessId = req.currentUser.businessId;
  const { rows: members } = await db.query(`
    SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0`,
  [businessId, req.currentUser.userId]);
  if (!members.length) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
  const { rows } = await db.query(`
    SELECT "Id", "OrderId", "Status", "Title" FROM "ProductionTasks"
    WHERE "BusinessId" = $1 AND "Id" = $2 AND "AssignedMembershipId" = $3 FOR UPDATE`,
  [businessId, taskId, members[0].Id]);
  if (!rows.length) throw AppError.notFound('task_not_found', 'Task not found.');
  const task = rows[0];
  if (['Completed', 'Cancelled', 'Blocked'].includes(task.Status)) {
    throw AppError.conflict('invalid_transition', `A ${task.Status} task cannot be reported on.`);
  }
  const { rows: updated } = await db.query(`
    UPDATE "ProductionTasks" SET "StatusBeforeBlock" = "Status", "Status" = 'Blocked',
      "BlockedType" = $1, "BlockedReason" = $2, "UpdatedByUserId" = $3, "UpdatedAtUtc" = now()
    WHERE "BusinessId" = $4 AND "Id" = $5
    RETURNING xmin::text::bigint AS "Version"`,
  [payload.type, payload.description, req.currentUser.userId, businessId, taskId]);
  await recordTaskEvent(db, businessId, taskId, 'issue_reported', task.Status, 'Blocked',
    req.currentUser.userId, payload.description, { type: payload.type });
  await queueTaskIssueNotifications(db, businessId, taskId, updated[0]?.Version, task.Title, payload.description,
    req.currentUser.userId);
  await syncOrderFromTasks(db, businessId, task.OrderId);
}

export async function createTaskWorkerRequest(db, req, taskId, payload) {
  const businessId = req.currentUser.businessId;
  const { rows: memberships } = await db.query(`
    SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0`,
  [businessId, req.currentUser.userId]);
  if (!memberships.length) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
  const membershipId = memberships[0].Id;
  const { rows: tasks } = await db.query(`
    SELECT "Id", "OrderId", "Title", "Status", "EstimatedMinutes", "AssignedMembershipId", xmin::text::bigint AS "Version"
    FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "Id" = $2 AND "AssignedMembershipId" = $3 FOR UPDATE`,
  [businessId, taskId, membershipId]);
  if (!tasks.length) throw AppError.notFound('task_not_found', 'Task not found.');
  const task = tasks[0];
  if (payload.type === 'Discrepancy') {
    if (!['InProgress', 'Paused', 'Completed'].includes(task.Status)) {
      throw AppError.conflict('task_not_started', 'Report planned versus actual time after work has started.');
    }
    if (!Number.isInteger(task.EstimatedMinutes) || task.EstimatedMinutes < 1) {
      throw AppError.conflict('task_estimate_missing', 'A planned duration must be configured before reporting a time discrepancy.');
    }
    if (!Number.isInteger(payload.actualMinutes)) {
      throw AppError.badRequest('actual_minutes_required', 'Actual minutes are required for a discrepancy report.');
    }
  } else if (['Completed', 'Cancelled'].includes(task.Status)) {
    throw AppError.conflict('task_closed', 'Assistance and reassignment requests are only available for open tasks.');
  } else if (payload.actualMinutes !== undefined) {
    throw AppError.badRequest('unexpected_actual_minutes', 'Actual minutes are only valid for discrepancy reports.');
  }
  const id = randomUUID();
  const plannedMinutes = payload.type === 'Discrepancy' ? task.EstimatedMinutes : null;
  const actualMinutes = payload.type === 'Discrepancy' ? payload.actualMinutes : null;
  const { rows: inserted } = await db.query(`
    INSERT INTO "TaskWorkerRequests" ("Id", "BusinessId", "TaskId", "RequestedByMembershipId", "Type", "Status",
      "Message", "PlannedMinutes", "ActualMinutes", "CreatedAtUtc")
    VALUES ($1,$2,$3,$4,$5,'Pending',$6,$7,$8,now())
    ON CONFLICT DO NOTHING
    RETURNING "Id", "Type", "Status", "Message", "PlannedMinutes", "ActualMinutes", "CreatedAtUtc"`,
  [id, businessId, taskId, membershipId, payload.type, payload.message, plannedMinutes, actualMinutes]);
  if (!inserted.length) throw AppError.conflict('request_already_pending', 'A request of this type is already pending for this task.');
  await recordTaskEvent(db, businessId, taskId, 'worker_request_submitted', task.Status, task.Status,
    req.currentUser.userId, payload.message, { requestId: id, requestType: payload.type, plannedMinutes, actualMinutes });
  await queueTaskWorkerRequestNotifications(db, businessId, taskId, id, payload.type, req.currentUser.userId);
  return inserted[0];
}

export async function reviewTaskWorkerRequest(db, req, requestId, payload, allowed) {
  const businessId = req.currentUser.businessId;
  const { rows } = await db.query(`
    SELECT r."Id", r."TaskId", r."Type", r."Status", t."Status" AS "TaskStatus", o."LocationId"
    FROM "TaskWorkerRequests" r
    JOIN "ProductionTasks" t ON t."BusinessId" = r."BusinessId" AND t."Id" = r."TaskId"
    JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
    WHERE r."BusinessId" = $1 AND r."Id" = $2
      AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[])) FOR UPDATE OF r`,
  [businessId, requestId, allowed]);
  if (!rows.length) throw AppError.notFound('task_request_not_found', 'Worker request not found.');
  const request = rows[0];
  if (request.Status !== 'Pending') throw AppError.conflict('request_already_reviewed', 'This worker request has already been reviewed.');
  const { rows: updated } = await db.query(`
    UPDATE "TaskWorkerRequests" SET "Status" = $1, "ReviewedByUserId" = $2, "ReviewNote" = $3, "ReviewedAtUtc" = now()
    WHERE "BusinessId" = $4 AND "Id" = $5 AND "Status" = 'Pending'
    RETURNING "Id", "TaskId", "Type", "Status", "Message", "PlannedMinutes", "ActualMinutes", "ReviewNote", "ReviewedAtUtc"`,
  [payload.status, req.currentUser.userId, clean(payload.note), businessId, requestId]);
  if (!updated.length) throw AppError.conflict('request_already_reviewed', 'This worker request has already been reviewed.');
  await recordTaskEvent(db, businessId, request.TaskId, 'worker_request_reviewed', request.TaskStatus, request.TaskStatus,
    req.currentUser.userId, clean(payload.note), { requestId, requestType: request.Type, decision: payload.status });
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'TaskWorkerRequest')`,
  [randomUUID(), `task.worker_request.${payload.status.toLowerCase()}`, req.currentUser.userId, businessId,
    JSON.stringify({ type: request.Type, taskId: request.TaskId, note: clean(payload.note) }), requestId]);
  return updated[0];
}

async function queueTaskWorkerRequestNotifications(db, businessId, taskId, requestId, requestType, actorUserId) {
  const { rows: recipients } = await db.query(`
    SELECT DISTINCT membership."Id", membership."DisplayName", appUser."Email"
    FROM "Memberships" membership
    JOIN "AspNetUsers" appUser ON appUser."Id" = membership."UserId"
    WHERE membership."BusinessId" = $1 AND membership."Status" = 0
      AND (membership."IsOwner" = TRUE OR EXISTS (
        SELECT 1 FROM "MembershipRoles" membershipRole
        JOIN "RolePermissions" rolePermission ON rolePermission."RoleId" = membershipRole."RoleId"
        WHERE membershipRole."BusinessId" = membership."BusinessId"
          AND membershipRole."MembershipId" = membership."Id"
          AND rolePermission."Permission" = 'tasks.manage'
      ))`, [businessId]);
  const typeLabel = requestType === 'Assistance' ? 'assistance' : requestType === 'Reassignment' ? 'reassignment' : 'planned-versus-actual time';
  for (const recipient of recipients) {
    await queueTaskNotification(db, {
      businessId, taskId, membershipId: recipient.Id, version: requestId, actorUserId,
      templateKey: `task.worker-request.${requestType.toLowerCase()}`,
      subject: `A worker submitted a ${typeLabel} request`,
      message: `A production task has a new ${typeLabel} request. Open Avzar to review the request details.`,
      title: 'Worker request needs review', body: `A production task has a new ${typeLabel} request.`,
    });
  }
}

async function requestGarmentAlterations(db, req, garmentId, notes, allowed) {
  const businessId = req.currentUser.businessId;
  const { rows: garmentRows } = await db.query(`
    SELECT g."OrderId", o."Status", o."LocationId"
    FROM "OrderGarments" g JOIN "Orders" o ON o."BusinessId" = g."BusinessId" AND o."Id" = g."OrderId"
    WHERE g."BusinessId" = $1 AND g."Id" = $2
      AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
    FOR UPDATE OF g, o`,
  [businessId, garmentId, allowed]);
  if (!garmentRows.length) throw AppError.notFound('garment_not_found', 'Garment not found.');
  const garment = garmentRows[0];
  if (!isProductionOpen(garment.Status)) {
    throw AppError.conflict('order_not_active', 'Alterations can only be requested while the order is in production.');
  }
  const { rows: conditionalTasks } = await db.query(`
    SELECT "Id" FROM "ProductionTasks"
    WHERE "BusinessId" = $1 AND "OrderGarmentId" = $2 AND "IsConditional"
      AND "Status" = 'Cancelled' AND "CancelReason" = 'Not required (conditional step)'
    FOR UPDATE`,
  [businessId, garmentId]);
  if (!conditionalTasks.length) {
    throw AppError.conflict('no_conditional_steps', 'This garment has no alteration step to activate (it was already requested, or its workflow has none).');
  }
  const taskIds = conditionalTasks.map((task) => task.Id);
  await db.query(`
    UPDATE "ProductionTasks" SET "Status" = 'Pending', "CancelReason" = NULL,
      "UpdatedByUserId" = $1, "UpdatedAtUtc" = now()
    WHERE "BusinessId" = $2 AND "Id" = ANY($3::uuid[])`,
  [req.currentUser.userId, businessId, taskIds]);
  for (const taskId of taskIds) {
    await recordTaskEvent(db, businessId, taskId, 'alterations_requested',
      'Cancelled', 'Pending', req.currentUser.userId, notes);
  }
  await db.query(`
    UPDATE "OrderGarments" SET "AlterationNotes" = left(
      CASE WHEN COALESCE("AlterationNotes", '') = '' THEN $1
        ELSE "AlterationNotes" || E'\\n' || $1 END, 2000),
      "UpdatedAtUtc" = now()
    WHERE "BusinessId" = $2 AND "Id" = $3`,
  [`[Alterations ${new Date().toISOString().slice(0, 10)}] ${notes}`, businessId, garmentId]);
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc",
      "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, 'garment.alterations_requested', $2, $3, now(), $4::jsonb, $5, 'OrderGarment')`,
  [randomUUID(), req.currentUser.userId, businessId, JSON.stringify({ notes }), garmentId]);
  await syncOrderFromTasks(db, businessId, garment.OrderId);
  return taskIds;
}

async function writeWorkflow(db, req, payload, dependencies, workflowId = randomUUID()) {
  const businessId = req.currentUser.businessId;
  await db.query(`SELECT "Id" FROM "Businesses" WHERE "Id" = $1 FOR UPDATE`, [businessId]);
  const { rows: existingRows } = await db.query(`
    SELECT "Id", "Name", "IsDefault", "IsActive" FROM "Workflows"
    WHERE "BusinessId" = $1 ORDER BY "Name" FOR UPDATE`,
  [businessId]);
  const existing = existingRows.find((row) => row.Id === workflowId);
  if (workflowId !== existing?.Id && existingRows.some((row) => row.Name === payload.name)) {
    throw AppError.conflict('workflow_exists', 'A workflow with this name already exists.');
  }
  if (existing && existingRows.some((row) => row.Id !== workflowId && row.Name === payload.name)) {
    throw AppError.conflict('workflow_exists', 'A workflow with this name already exists.');
  }
  const isDefault = payload.isDefault || (!existing && existingRows.length === 0);
  if (existing?.IsDefault && !payload.isDefault) {
    throw AppError.badRequest('default_required', 'Make another workflow the default instead of unsetting this one.');
  }
  if ((isDefault || existing?.IsDefault) && !payload.isActive) {
    throw AppError.badRequest('default_must_be_active', 'The default workflow must be active.');
  }
  const categoryKeys = new Set();
  const categories = payload.garmentCategories.map((category) => category.trim())
    .filter((category) => {
      const normalized = category.toLowerCase();
      if (!category || categoryKeys.has(normalized)) return false;
      categoryKeys.add(normalized);
      return true;
    });
  if (isDefault) {
    await db.query(`UPDATE "Workflows" SET "IsDefault" = FALSE, "UpdatedAtUtc" = now() WHERE "BusinessId" = $1 AND "IsDefault"`, [businessId]);
  }

  if (!existing) {
    await db.query(`
      INSERT INTO "Workflows" ("Id", "BusinessId", "Name", "Description", "IsDefault", "IsActive", "GarmentCategories", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, $7::text[], now())`,
    [workflowId, businessId, payload.name, clean(payload.description), isDefault, payload.isActive, categories]);
  } else {
    await db.query(`
      UPDATE "Workflows" SET "Name" = $1, "Description" = $2, "IsDefault" = $3, "IsActive" = $4,
        "GarmentCategories" = $5::text[], "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $6 AND "Id" = $7`,
    [payload.name, clean(payload.description), isDefault, payload.isActive, categories, businessId, workflowId]);
  }

  const { rows: currentStages } = await db.query(`
    SELECT "Id", "Key" FROM "Stages" WHERE "BusinessId" = $1 AND "WorkflowId" = $2`,
  [businessId, workflowId]);
  const currentByKey = new Map(currentStages.map((stage) => [stage.Key, stage]));
  const incomingKeys = new Set(payload.stages.map((stage) => stage.key));
  const removed = currentStages.filter((stage) => !incomingKeys.has(stage.Key)).map((stage) => stage.Id);
  const existingStageIds = currentStages.map((stage) => stage.Id);
  const stageIds = new Map(payload.stages.map((stage) => [
    stage.key, currentByKey.get(stage.key)?.Id ?? randomUUID(),
  ]));
  if (existingStageIds.length) {
    await db.query(`
      DELETE FROM "StageDependencies" WHERE "BusinessId" = $1
        AND ("StageId" = ANY($2::uuid[]) OR "DependsOnStageId" = ANY($2::uuid[]))`,
    [businessId, existingStageIds]);
  }
  if (removed.length) {
    await db.query(`DELETE FROM "Stages" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`, [businessId, removed]);
  }

  for (let index = 0; index < payload.stages.length; index++) {
    const stage = payload.stages[index];
    const stageId = stageIds.get(stage.key);
    const values = [stageId, businessId, workflowId, stage.key, stage.name, index,
      clean(stage.instructions), clean(stage.requiredSkill)?.toLowerCase() ?? null, stage.defaultMinutes ?? null,
      stage.isConditional, stage.completionChecks];
    if (currentByKey.has(stage.key)) {
      await db.query(`
        UPDATE "Stages" SET "Name" = $1, "SortOrder" = $2, "Instructions" = $3, "RequiredSkill" = $4,
          "DefaultMinutes" = $5, "IsConditional" = $6, "CompletionChecks" = $7::text[], "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $8 AND "WorkflowId" = $9 AND "Id" = $10`,
      [stage.name, index, values[6], values[7], values[8], stage.isConditional, stage.completionChecks,
        businessId, workflowId, stageId]);
    } else {
      await db.query(`
        INSERT INTO "Stages" ("Id", "BusinessId", "WorkflowId", "Key", "Name", "SortOrder", "Instructions",
          "RequiredSkill", "DefaultMinutes", "IsConditional", "CompletionChecks", "CreatedAtUtc")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], now())`, values);
    }
  }
  for (const stage of payload.stages) {
    for (const prerequisite of dependencies.get(stage.key) ?? []) {
      await db.query(`
        INSERT INTO "StageDependencies" ("StageId", "DependsOnStageId", "BusinessId")
        VALUES ($1, $2, $3)`,
      [stageIds.get(stage.key), stageIds.get(prerequisite), businessId]);
    }
  }

  await auditWorkflow(db, req, existing ? 'workflow.updated' : 'workflow.created', workflowId, payload.name);
  return loadWorkflow(db, businessId, workflowId);
}

async function loadOrder(db, businessId, id, allowed) {
  const { rows } = await db.query(`
    SELECT o.*, o.xmin::text::bigint AS "Version", c."FullName" AS "CustomerName"
    FROM "Orders" o JOIN "Customers" c ON c."Id" = o."CustomerId" AND c."BusinessId" = o."BusinessId"
    WHERE o."BusinessId" = $1 AND o."Id" = $2 AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))`,
  [businessId, id, allowed]);
  if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
  const order = rows[0];
  const [garmentResult, progressResult] = await Promise.all([
    db.query(`
      SELECT "Id", "LineNumber", "Name", "Category", "Quantity", "UnitPrice", "LineTotal", "Fabric", "Colour",
        "StyleInstructions", "AlterationNotes", "MeasurementSetId", "MeasurementRevision", "MeasurementSnapshotJson",
        "DesignId", "DesignNameSnapshot"
      FROM "OrderGarments" WHERE "BusinessId" = $1 AND "OrderId" = $2 ORDER BY "LineNumber"`,
    [businessId, id]),
    db.query(`
      SELECT "Status", "DeadlineUtc" FROM "ProductionTasks"
      WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" <> 'Cancelled'`, [businessId, id]),
  ]);
  const tasks = progressResult.rows;
  const completed = tasks.filter((task) => task.Status === 'Completed').length;
  const progress = tasks.length ? {
    totalTasks: tasks.length,
    completed,
    inProgress: tasks.filter((task) => task.Status === 'InProgress').length,
    blocked: tasks.filter((task) => task.Status === 'Blocked').length,
    overdue: tasks.filter((task) => !['Completed', 'Cancelled'].includes(task.Status) && task.DeadlineUtc && new Date(task.DeadlineUtc) < new Date()).length,
    percentComplete: Math.round(100 * completed / tasks.length),
  } : null;
  return {
    id: order.Id,
    orderNumber: order.OrderNumber,
    status: order.Status,
    customerId: order.CustomerId,
    customerName: order.CustomerName,
    locationId: order.LocationId,
    promisedDate: order.PromisedDate instanceof Date ? order.PromisedDate.toISOString().slice(0, 10) : String(order.PromisedDate).slice(0, 10),
    priority: order.Priority,
    deliveryMethod: order.DeliveryMethod,
    deliveryAddress: order.DeliveryAddress,
    deliveryInstructions: order.DeliveryInstructions,
    notes: order.Notes,
    currencyCode: order.CurrencyCode,
    subtotal: Number(order.Subtotal),
    discount: Number(order.Discount),
    total: Number(order.Total),
    version: Number(order.Version),
    allowedStatusChanges: allowedNextStatuses(order.Status),
    createdAtUtc: order.CreatedAtUtc,
    quotedAtUtc: order.QuotedAtUtc,
    confirmedAtUtc: order.ConfirmedAtUtc,
    cancelledAtUtc: order.CancelledAtUtc,
    cancellationReason: order.CancellationReason,
    readyAtUtc: order.ReadyAtUtc,
    deliveredAtUtc: order.DeliveredAtUtc,
    progress,
    garments: garmentResult.rows.map((garment) => ({
      id: garment.Id,
      lineNumber: garment.LineNumber,
      name: garment.Name,
      category: garment.Category,
      quantity: garment.Quantity,
      unitPrice: Number(garment.UnitPrice),
      lineTotal: Number(garment.LineTotal),
      fabric: garment.Fabric,
      colour: garment.Colour,
      styleInstructions: garment.StyleInstructions,
      alterationNotes: garment.AlterationNotes,
      measurementSetId: garment.MeasurementSetId,
      measurementRevision: garment.MeasurementRevision,
      measurementSnapshot: typeof garment.MeasurementSnapshotJson === 'string'
        ? JSON.parse(garment.MeasurementSnapshotJson) : garment.MeasurementSnapshotJson,
      designId: garment.DesignId,
      designName: garment.DesignNameSnapshot,
    })),
  };
}

const jsonText = (value) => (value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value));
const parseJson = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

// Builds and writes one order garment as follows: a line keeps its frozen
// measurement and design snapshots unless the caller picks a different profile/revision or design, and a calculator
// `pricing` input is recomputed here (the client never supplies results) and stored as a snapshot.
async function addGarment(db, req, orderId, garment, index, customerId, existingId = null, exactLineCents = null) {
  if (exactLineCents === null && !hasAtMostPlaces(garment.unitPrice, 2)) {
    throw AppError.badRequest('invalid_price', `'${garment.name}': price can have at most 2 decimal places.`);
  }
  const businessId = req.currentUser.businessId;
  const unitPriceCents = decimalCents(garment.unitPrice);
  const lineTotal = exactLineCents === null ? mulMoney(garment.quantity, garment.unitPrice) : Number(exactLineCents) / 100;

  let existing = null;
  if (existingId) {
    const found = await db.query(`
      SELECT "UnitPrice", "MeasurementSetId", "MeasurementRevision", "MeasurementSnapshotJson", "DesignId",
        "DesignNameSnapshot", "DesignPriceSnapshot", "PricingSnapshotJson", "PriceOverrideReason"
      FROM "OrderGarments" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Id" = $3`,
    [businessId, orderId, existingId]);
    existing = found.rows[0] ?? null;
  }

  let category = clean(garment.category);
  let measurementSetId = null;
  let measurementRevision = null;
  let measurementSnapshot = null;
  if (garment.measurementSetId) {
    measurementSetId = garment.measurementSetId;
    const unchanged = existing !== null && existing.MeasurementSetId === garment.measurementSetId
      && (garment.measurementRevision == null || garment.measurementRevision === existing.MeasurementRevision)
      && existing.MeasurementSnapshotJson !== null;
    if (unchanged) {
      measurementRevision = existing.MeasurementRevision;
      measurementSnapshot = jsonText(existing.MeasurementSnapshotJson);
    } else {
      const set = await db.query(`
        SELECT s."CurrentRevision", s."Label", s."TemplateId" FROM "MeasurementSets" s
        WHERE s."BusinessId" = $1 AND s."Id" = $2 AND s."CustomerId" = $3`,
      [businessId, garment.measurementSetId, customerId]);
      if (!set.rows.length) throw AppError.badRequest('unknown_measurement_set', 'That measurement profile does not belong to this customer.');
      const number = garment.measurementRevision ?? set.rows[0].CurrentRevision;
      const revision = await db.query(`
        SELECT "RevisionNumber", "ValuesJson", "Notes", "CreatedAtUtc" FROM "MeasurementRevisions"
        WHERE "BusinessId" = $1 AND "SetId" = $2 AND "RevisionNumber" = $3`,
      [businessId, garment.measurementSetId, number]);
      if (!revision.rows.length) throw AppError.badRequest('unknown_revision', `Revision ${number} does not exist for that measurement profile.`);
      const template = await db.query('SELECT "Name" FROM "MeasurementTemplates" WHERE "BusinessId" = $1 AND "Id" = $2', [businessId, set.rows[0].TemplateId]);
      measurementRevision = revision.rows[0].RevisionNumber;
      measurementSnapshot = JSON.stringify({
        templateName: template.rows[0].Name,
        profile: set.rows[0].Label,
        revision: revision.rows[0].RevisionNumber,
        recordedAtUtc: revision.rows[0].CreatedAtUtc,
        notes: revision.rows[0].Notes,
        values: parseJson(revision.rows[0].ValuesJson),
      });
      category ??= template.rows[0].Name;
    }
  }

  let designId = null;
  let designName = null;
  let designPrice = null;
  if (garment.designId) {
    designId = garment.designId;
    if (existing !== null && existing.DesignId === garment.designId) {
      designName = existing.DesignNameSnapshot; // unchanged: keep the snapshot taken when it was linked
      designPrice = existing.DesignPriceSnapshot;
    } else {
      const { rows } = await db.query(`
        SELECT "Name", "BasePrice", "Status" FROM "Designs" WHERE "BusinessId" = $1 AND "Id" = $2`,
      [businessId, garment.designId]);
      if (!rows.length) throw AppError.badRequest('unknown_design', 'That design was not found.');
      if (rows[0].Status !== 'Active') throw AppError.conflict('design_archived', `'${rows[0].Name}' is archived. Restore it before using it on an order.`);
      designName = rows[0].Name;
      designPrice = rows[0].BasePrice;
    }
  }

  let pricingSnapshot = existing === null ? null : jsonText(existing.PricingSnapshotJson);
  let overrideReason = existing === null ? null : existing.PriceOverrideReason;
  if (!garment.pricing) {
    if (clean(garment.priceOverrideReason)) {
      throw AppError.badRequest('override_without_pricing', 'A price override reason only applies when the price comes from the calculator.');
    }
    // Manual price. A snapshot that no longer explains the price would mislead, so drop it when the price changed.
    if (pricingSnapshot !== null && existing !== null && decimalCents(existing.UnitPrice) !== unitPriceCents) {
      pricingSnapshot = null;
      overrideReason = null;
    }
  } else {
    if (!req.currentUser.isOwner && !req.currentUser.permissions.includes('pricing.view')) {
      throw AppError.forbidden('permission_denied', 'You need the pricing permission to use the calculator on an order.');
    }
    const calculation = await calculatePricing(db, businessId, garment.pricing);
    const suggested = calculation.result.unitPrice;
    const suggestedCents = BigInt(Math.round(Number(suggested) * 100));
    let reason = clean(garment.priceOverrideReason);
    if (unitPriceCents !== suggestedCents) {
      if (reason === null || reason.length < 3) {
        throw AppError.badRequest('override_reason_required',
          `'${garment.name}': the price ${garment.unitPrice} differs from the calculated ${suggested}. Give a reason for the change.`);
      }
    } else reason = null;
    overrideReason = reason;
    pricingSnapshot = JSON.stringify({
      calculatedAtUtc: new Date().toISOString(), input: garment.pricing, rules: calculation.rules, result: calculation.result,
      suggestedUnitPrice: suggested, finalUnitPrice: garment.unitPrice,
    });
  }

  const values = [
    existingId ?? randomUUID(), businessId, orderId, index, garment.name, category, garment.quantity,
    exactLineCents === null ? toMoney(garment.unitPrice) : formatCents(unitPriceCents),
    exactLineCents === null ? toMoney(lineTotal) : formatCents(exactLineCents), clean(garment.fabric), clean(garment.colour),
    clean(garment.styleInstructions), clean(garment.alterationNotes), designId,
    designName, designPrice, measurementSetId, measurementRevision,
    jsonText(measurementSnapshot), jsonText(pricingSnapshot), overrideReason,
  ];
  if (existingId) {
    await db.query(`
      UPDATE "OrderGarments" SET "LineNumber" = $4, "Name" = $5, "Category" = $6, "Quantity" = $7, "UnitPrice" = $8,
        "LineTotal" = $9, "Fabric" = $10, "Colour" = $11, "StyleInstructions" = $12, "AlterationNotes" = $13,
        "DesignId" = $14, "DesignNameSnapshot" = $15, "DesignPriceSnapshot" = $16, "MeasurementSetId" = $17,
        "MeasurementRevision" = $18, "MeasurementSnapshotJson" = $19::jsonb, "PricingSnapshotJson" = $20::jsonb,
        "PriceOverrideReason" = $21, "UpdatedAtUtc" = now()
      WHERE "BusinessId" = $2 AND "OrderId" = $3 AND "Id" = $1`, values);
  } else {
    await db.query(`
      INSERT INTO "OrderGarments" ("Id", "BusinessId", "OrderId", "LineNumber", "Name", "Category", "Quantity",
        "UnitPrice", "LineTotal", "Fabric", "Colour", "StyleInstructions", "AlterationNotes", "DesignId",
        "DesignNameSnapshot", "DesignPriceSnapshot", "MeasurementSetId", "MeasurementRevision", "MeasurementSnapshotJson",
        "PricingSnapshotJson", "PriceOverrideReason", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20::jsonb, $21, now())`,
    values);
  }
  return lineTotal;
}

class DryRunRollback extends Error {
  constructor(result) { super('dry run'); this.result = result; }
}

// Runs callback in a transaction and always rolls it back, returning the callback's result.
async function dryRun(pool, callback) {
  try {
    await transaction(pool, async (client) => { throw new DryRunRollback(await callback(client)); });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  }
  throw new Error('dryRun finished without a result.');
}

const CATEGORY_CHANGE_CANCEL_REASON = 'Order amended: garment category changed, tasks regenerated.';

// For each retained line whose category changed, cancels its unstarted tasks when the new category selects a
// different workflow. The caller has already established that no task on the order has started.
async function cancelTasksForCategoryChanges(client, { businessId, orderId, oldGarments, actorUserId }) {
  const result = { regenerateIds: new Set(), cancelled: 0, lines: [] };
  const oldById = new Map(oldGarments.map((garment) => [garment.Id, garment]));
  const { rows: current } = await client.query(`
    SELECT "Id", "Name", "Category", "LineNumber" FROM "OrderGarments"
    WHERE "BusinessId" = $1 AND "OrderId" = $2 ORDER BY "LineNumber"`, [businessId, orderId]);
  const changed = current.filter((garment) => oldById.has(garment.Id) && !sameCategory(oldById.get(garment.Id).Category, garment.Category));
  if (!changed.length) return result;
  const { rows: workflows } = await client.query(`
    SELECT "Id", "Name", "IsDefault", "GarmentCategories" FROM "Workflows"
    WHERE "BusinessId" = $1 AND "IsActive" ORDER BY "IsDefault" DESC, "Name"`, [businessId]);
  for (const garment of changed) {
    const { rows: tasks } = await client.query(`
      SELECT t."Id", t."Status", s."WorkflowId"
      FROM "ProductionTasks" t
      LEFT JOIN "Stages" s ON s."BusinessId" = t."BusinessId" AND s."Id" = t."StageId"
      WHERE t."BusinessId" = $1 AND t."OrderId" = $2 AND t."OrderGarmentId" = $3
      FOR UPDATE OF t`, [businessId, orderId, garment.Id]);
    const live = tasks.filter((task) => ['Pending', 'Scheduled'].includes(task.Status));
    const workflow = pickWorkflow(workflows, garment.Category);
    const decision = planLineRegeneration({
      categoryChanged: true,
      liveTaskCount: live.length,
      hasManualTask: tasks.some((task) => !task.WorkflowId),
      existingWorkflowIds: tasks.map((task) => task.WorkflowId).filter(Boolean),
      newWorkflowId: workflow?.Id ?? null,
    });
    const from = oldById.get(garment.Id).Category;
    result.lines.push({ lineNumber: garment.LineNumber, name: garment.Name, from, to: garment.Category, action: decision.action, reason: decision.reason });
    if (decision.action !== 'regenerate') continue;
    for (const task of live) {
      await client.query(`
        UPDATE "ProductionTasks" SET "Status" = 'Cancelled', "CancelReason" = $1, "PlannedStartUtc" = NULL, "PlannedEndUtc" = NULL,
          "UpdatedByUserId" = $2, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $3 AND "Id" = $4`,
      [CATEGORY_CHANGE_CANCEL_REASON, actorUserId, businessId, task.Id]);
      await recordTaskEvent(client, businessId, task.Id, 'order_amendment_cancelled', task.Status, 'Cancelled', actorUserId,
        CATEGORY_CHANGE_CANCEL_REASON, { from, to: garment.Category });
    }
    result.cancelled += live.length;
    result.regenerateIds.add(garment.Id);
  }
  return result;
}

// Amends a confirmed or in-production order whose production has not started. With dryRun the caller rolls the
// transaction back, so audit rows and notifications are skipped here. Returns { order, tasksCreated, scheduleReplanRequired, impact }.
async function amendOrder(client, req, orderId, payload, allowed, { dryRun: isDryRun = false } = {}) {
  const businessId = req.currentUser.businessId;
  const { rows } = await client.query(`
    SELECT *, xmin::text::bigint AS "Version" FROM "Orders"
    WHERE "BusinessId" = $1 AND "Id" = $2 AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
  [businessId, orderId, allowed]);
  if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
  const current = rows[0];
  if (!isProductionActive(current.Status)) {
    throw AppError.conflict('order_not_amendable', 'Only confirmed or in-production orders can be amended.');
  }
  if (Number(current.Version) !== payload.version) {
    throw AppError.conflict('stale_version', 'This order was changed by someone else. Reload and try again.');
  }
  await ensureLocation(client, businessId, payload.locationId, allowed);
  const { rows: business } = await client.query(`
    SELECT (now() AT TIME ZONE "TimeZoneId")::date::text AS "Today" FROM "Businesses" WHERE "Id" = $1`, [businessId]);
  if (payload.promisedDate < business[0].Today) {
    throw AppError.badRequest('promised_date_in_past', 'The promised date cannot be in the past.');
  }
  if (payload.deliveryMethod === 'Delivery' && !clean(payload.deliveryAddress)) {
    throw AppError.badRequest('delivery_address_required', 'A delivery address is required for delivery orders.');
  }
  const { rows: oldGarments } = await client.query(`
    SELECT "Id", "Quantity", "Name", "Category", "UnitPrice", "Fabric", "Colour", "StyleInstructions", "AlterationNotes",
      "MeasurementSetId", "MeasurementRevision", "DesignId"
    FROM "OrderGarments" WHERE "BusinessId" = $1 AND "OrderId" = $2 FOR UPDATE`, [businessId, orderId]);
  const oldById = new Map(oldGarments.map((g) => [g.Id, g]));
  const retained = new Set();
  for (const garment of payload.garments) {
    if (garment.id && !oldById.has(garment.id)) throw AppError.badRequest('unknown_line', 'A garment line in the request does not belong to this order.');
    if (garment.id && retained.has(garment.id)) throw AppError.badRequest('duplicate_line', 'The same garment line appears twice.');
    if (garment.id) retained.add(garment.id);
  }
  const removed = oldGarments.filter((g) => !retained.has(g.Id));
  if (removed.length) {
    const removedIds = removed.map((g) => g.Id);
    const linked = await client.query(`SELECT 1 FROM "ProductionTasks" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "OrderGarmentId" = ANY($3::uuid[]) LIMIT 1`,
      [businessId, orderId, removedIds]);
    if (linked.rows.length) throw AppError.conflict('garment_has_tasks', 'A garment with production-task history cannot be removed. Keep the line and amend its details instead.');
  }
  const tasks = await client.query(`
    SELECT "Id", "OrderGarmentId", "Status", "ActualStartUtc" FROM "ProductionTasks"
    WHERE "BusinessId" = $1 AND "OrderId" = $2 FOR UPDATE`, [businessId, orderId]);
  if (tasks.rows.some((t) => !['Pending', 'Scheduled', 'Cancelled'].includes(t.Status) || t.ActualStartUtc)) {
    throw AppError.conflict('production_already_started', 'This order has started or completed production work. Amendments are blocked to protect task history; arrange the change as a separate alteration or task.');
  }
  if (!hasAtMostPlaces(payload.discount, 2)) throw AppError.badRequest('invalid_discount', 'Discount can have at most 2 decimal places.');
  let subtotal = 0;
  for (let index = 0; index < payload.garments.length; index += 1) {
    const garment = payload.garments[index];
    subtotal = addMoney(subtotal, await addGarment(client, req, orderId, garment, index + 1, current.CustomerId, garment.id ?? null));
  }
  if (payload.discount > subtotal) throw AppError.badRequest('discount_exceeds_total', 'The discount cannot exceed the order subtotal.');
  const newTotal = subtractMoney(subtotal, payload.discount);
  if (Number(current.Total) !== Number(newTotal)) {
    const invoices = await client.query(`SELECT 1 FROM "Invoices" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" <> 'Void' LIMIT 1`, [businessId, orderId]);
    if (invoices.rows.length) throw AppError.conflict('order_has_invoices', 'Void or settle the existing invoice workflow before changing the order total.');
  }
  if (payload.locationId !== current.LocationId && tasks.rows.some((t) => t.Status !== 'Cancelled')) {
    throw AppError.conflict('tasks_location_locked', 'An order with production tasks cannot be moved to another location.');
  }
  await client.query(`
    UPDATE "Orders" SET "LocationId" = $1, "PromisedDate" = $2::date, "Priority" = $3, "DeliveryMethod" = $4,
      "DeliveryAddress" = $5, "DeliveryInstructions" = $6, "Notes" = $7, "Subtotal" = $8, "Discount" = $9,
      "Total" = $10, "UpdatedAtUtc" = now()
    WHERE "BusinessId" = $11 AND "Id" = $12 AND xmin = $13::xid`,
  [payload.locationId, payload.promisedDate, payload.priority, payload.deliveryMethod, clean(payload.deliveryAddress),
    clean(payload.deliveryInstructions), clean(payload.notes), toMoney(subtotal), toMoney(payload.discount), toMoney(newTotal),
    businessId, orderId, payload.version]);
  if (removed.length) await client.query(`DELETE FROM "OrderGarments" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`, [businessId, removed.map((g) => g.Id)]);
  // A line whose category now selects a different workflow gets a fresh set of tasks; the old unstarted ones are
  // cancelled and stay in the history. Everything else keeps its tasks.
  const regeneration = await cancelTasksForCategoryChanges(client, { businessId, orderId, oldGarments, actorUserId: req.currentUser.userId });
  // Invalidate only unstarted schedule slots. The shop planner can then produce a fresh preview
  // from the amended deadlines, priorities and quantities; started work is rejected above.
  const previouslyScheduled = await client.query(`SELECT "Id" FROM "ProductionTasks"
    WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" = 'Scheduled' FOR UPDATE`, [businessId, orderId]);
  const previouslyScheduledIds = new Set(previouslyScheduled.rows.map((row) => row.Id));
  const invalidated = await client.query(`
    UPDATE "ProductionTasks" SET "Quantity" = g."Quantity", "DeadlineUtc" = (($3::date + time '23:59') AT TIME ZONE b."TimeZoneId"),
      "Priority" = $4, "PlannedStartUtc" = NULL, "PlannedEndUtc" = NULL,
      "Status" = CASE WHEN "Status" = 'Scheduled' THEN 'Pending' ELSE "Status" END,
      "UpdatedAtUtc" = now(), "UpdatedByUserId" = $5
    FROM "OrderGarments" g, "Businesses" b
    WHERE "ProductionTasks"."BusinessId" = $1 AND "ProductionTasks"."OrderId" = $2
      AND g."BusinessId" = $1 AND g."Id" = "ProductionTasks"."OrderGarmentId"
      AND b."Id" = $1 AND "ProductionTasks"."Status" IN ('Pending', 'Scheduled')
    RETURNING "ProductionTasks"."Id", "ProductionTasks"."Status"`,
  [businessId, orderId, payload.promisedDate, payload.priority, req.currentUser.userId]);
  const unscheduled = invalidated.rows.filter((row) => previouslyScheduledIds.has(row.Id));
  for (const task of unscheduled) {
    await client.query(`INSERT INTO "TaskEvents" ("Id", "BusinessId", "TaskId", "Type", "FromStatus", "ToStatus", "ActorUserId", "Note", "CreatedAtUtc")
      VALUES ($1, $2, $3, 'order_amendment_replan', 'Scheduled', 'Pending', $4, 'Order amended; schedule slot invalidated for replanning.', now())`,
    [randomUUID(), businessId, task.Id, req.currentUser.userId]);
  }
  const generated = await generateProductionTasks(client, businessId, orderId, req.currentUser.userId, {}, regeneration.regenerateIds);
  const scheduleReplanRequired = invalidated.rowCount > 0 || generated.tasksCreated > 0 || regeneration.cancelled > 0;
  const impact = {
    total: { previous: Number(current.Total), next: Number(newTotal) },
    promisedDate: { previous: String(current.PromisedDate).slice(0, 10), next: payload.promisedDate },
    priority: { previous: current.Priority, next: payload.priority },
    garments: {
      added: payload.garments.filter((garment) => !garment.id).length,
      removed: removed.length,
      categoryChanges: regeneration.lines,
    },
    tasks: { unscheduled: unscheduled.length, updated: invalidated.rowCount, cancelled: regeneration.cancelled, created: generated.tasksCreated },
    linesWithoutWorkflow: generated.garmentsWithoutWorkflow,
    scheduleReplanRequired,
  };
  if (isDryRun) return { impact };
  await auditOrder(client, req, 'order.amended', orderId, {
    previousTotal: Number(current.Total), total: Number(newTotal), promisedDate: payload.promisedDate,
    invalidatedScheduleSlots: invalidated.rowCount, tasksCreated: generated.tasksCreated, tasksCancelled: regeneration.cancelled,
    categoryChanges: regeneration.lines.filter((line) => line.action === 'regenerate').map((line) => ({ lineNumber: line.lineNumber, from: line.from, to: line.to })),
  });
  const updated = await loadOrder(client, businessId, orderId, allowed);
  await notify(client, {
    businessId, category: 'orders', eventType: 'order.changed', title: 'Order amended',
    body: `Order ${updated.orderNumber} was amended. Its unstarted tasks need a fresh schedule.`,
    dedupeKey: `order.amended:${orderId}:${updated.version}`, target: { kind: 'order', id: orderId },
    recipients: { permission: 'orders.manage', locationId: payload.locationId }, actorUserId: req.currentUser.userId,
  });
  // Step 16b: a customer who opted in hears that the order changed (never for a dry run, which returned above).
  await queueCustomerEvent(client, {
    businessId, customerId: current.CustomerId, kind: 'order.amended', subjectId: orderId, dedupeKey: `order.amended:${orderId}:${updated.version}`,
  });
  return { order: updated, tasksCreated: generated.tasksCreated, scheduleReplanRequired, impact };
}

async function getActiveMembershipId(pool, user) {
  const { rows } = await pool.query(`
    SELECT "Id" FROM "Memberships"
    WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0
    LIMIT 1`, [user.businessId, user.userId]);
  if (!rows.length) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
  return rows[0].Id;
}

export function createOrderRouter({ env, pool }) {
  const router = Router();

  const requireOrdersView = [requireBearerAuth(env, pool), requirePermission('orders.view')];
  const requireOrdersManage = [requireBearerAuth(env, pool), requirePermission('orders.manage')];
  const requireOrdersConfirm = [requireBearerAuth(env, pool), requirePermission('orders.confirm')];
  const requireFittingsManage = [requireBearerAuth(env, pool), requirePermission('fittings.manage')];
  const requireTasksView = [requireBearerAuth(env, pool), requirePermission('tasks.view')];
  const requireTasksManage = [requireBearerAuth(env, pool), requirePermission('tasks.manage')];
  const requireTasksAssign = [requireBearerAuth(env, pool), requirePermission('tasks.assign')];
  const requireTasksOverride = [requireBearerAuth(env, pool), requirePermission('tasks.override')];
  const requireTasksWork = [requireBearerAuth(env, pool), requirePermission('tasks.work')];
  const requireWorkflowsManage = [requireBearerAuth(env, pool), requirePermission('workflows.manage')];
  const requireWorkersManage = [requireBearerAuth(env, pool), requirePermission('workers.manage')];

  router.get('/orders', ...requireOrdersView, async (req, res) => {
    const { page, pageSize } = orderListPaging(req.query);
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(200).json(await listOrdersPage(pool, req.currentUser, allowed, req.query, page, pageSize));
  });

  router.get('/orders/export', ...requireOrdersView, async (req, res) => {
    orderListPaging(req.query); // a bad page value is refused as on the list; the export itself reads every page
    const allowed = await allowedLocations(pool, req.currentUser);
    const { csv } = await exportOrders(pool, req.currentUser,
      (page, pageSize) => listOrdersPage(pool, req.currentUser, allowed, req.query, page, pageSize),
      { status: req.query.status, customerId: req.query.customerId, locationId: req.query.locationId,
        dueFrom: req.query.dueFrom, dueTo: req.query.dueTo, search: req.query.search });
    return sendCsv(res, 'orders', csv);
  });

  router.get('/orders/:id', ...requireOrdersView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    return res.status(200).json(await loadOrder(pool, req.currentUser.businessId, req.params.id, await allowedLocations(pool, req.currentUser)));
  });

  router.get('/orders/:id/pricing', ...[requireBearerAuth(env, pool), requirePermission('pricing.view')], async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    const order = await loadOrder(pool, req.currentUser.businessId, req.params.id, allowed);
    const { rows } = await pool.query(`
      SELECT "Id", "LineNumber", "Name", "Quantity", "UnitPrice", "DesignPriceSnapshot",
        "PriceOverrideReason", "PricingSnapshotJson"
      FROM "OrderGarments" WHERE "BusinessId" = $1 AND "OrderId" = $2 ORDER BY "LineNumber"`,
    [req.currentUser.businessId, order.id]);
    return res.status(200).json({
      orderId: order.id, orderNumber: order.orderNumber, currencyCode: order.currencyCode,
      lines: rows.map((row) => ({
        lineId: row.Id, lineNumber: row.LineNumber, name: row.Name, quantity: row.Quantity,
        unitPrice: Number(row.UnitPrice), designPriceSnapshot: row.DesignPriceSnapshot === null ? null : Number(row.DesignPriceSnapshot),
        priceOverrideReason: row.PriceOverrideReason,
        calculation: typeof row.PricingSnapshotJson === 'string' ? JSON.parse(row.PricingSnapshotJson) : row.PricingSnapshotJson,
      })),
    });
  });

  router.post('/orders', ...requireOrdersManage, async (req, res) => {
    const payload = parse(createOrderSchema, req.body);
    const idempotencyKey = clean(req.get('idempotency-key'));
    if (idempotencyKey?.length > 100) throw AppError.badRequest('invalid_idempotency_key', 'Idempotency key is too long.');
    const businessId = req.currentUser.businessId;
    const allowed = await allowedLocations(pool, req.currentUser);
    try {
      const result = await transaction(pool, (client) => createOrderInTransaction(client, req.currentUser, payload, idempotencyKey));
      return res.status(result.created ? 201 : 200).json(result.order);
    } catch (error) {
      if (idempotencyKey && error?.code === '23505') {
        const { rows } = await pool.query(`SELECT "Id" FROM "Orders" WHERE "BusinessId" = $1 AND "IdempotencyKey" = $2`,
          [businessId, idempotencyKey]);
        if (rows.length) return res.status(200).json(await loadOrder(pool, businessId, rows[0].Id, allowed));
      }
      throw error;
    }
  });

  router.put('/orders/:id', ...requireOrdersManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const payload = parse(updateOrderSchema, req.body);
    const businessId = req.currentUser.businessId;
    const allowed = await allowedLocations(pool, req.currentUser);
    const order = await transaction(pool, async (client) => {
      const { rows } = await client.query(`
        SELECT *, xmin::text::bigint AS "Version" FROM "Orders"
        WHERE "BusinessId" = $1 AND "Id" = $2 AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
      [businessId, req.params.id, allowed]);
      if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
      const current = rows[0];
      if (Number(current.Version) !== payload.version) throw AppError.conflict('stale_version', 'This order was changed by someone else. Reload and try again.');
      if (!isEditable(current.Status)) {
        throw AppError.conflict('order_locked', 'Only draft or quoted orders can be edited here. Confirmed orders need an amendment.');
      }
      await ensureLocation(client, businessId, payload.locationId, allowed);
      const { rows: business } = await client.query(`
        SELECT (now() AT TIME ZONE "TimeZoneId")::date::text AS "Today" FROM "Businesses" WHERE "Id" = $1`, [businessId]);
      if (payload.promisedDate !== String(current.PromisedDate).slice(0, 10) && payload.promisedDate < business[0].Today) {
        throw AppError.badRequest('promised_date_in_past', 'The promised date cannot be in the past.');
      }
      if (payload.deliveryMethod === 'Delivery' && !clean(payload.deliveryAddress)) {
        throw AppError.badRequest('delivery_address_required', 'A delivery address is required for delivery orders.');
      }
      const { rows: oldGarments } = await client.query(`
        SELECT "Id" FROM "OrderGarments" WHERE "BusinessId" = $1 AND "OrderId" = $2 FOR UPDATE`,
      [businessId, req.params.id]);
      const oldIds = new Set(oldGarments.map((garment) => garment.Id));
      const retained = new Set();
      let subtotal = 0;
      for (let index = 0; index < payload.garments.length; index += 1) {
        const garment = payload.garments[index];
        if (garment.id && !oldIds.has(garment.id)) throw AppError.badRequest('unknown_line', 'A garment line in the request does not belong to this order.');
        if (garment.id && retained.has(garment.id)) throw AppError.badRequest('duplicate_line', 'The same garment line appears twice.');
        if (garment.id) retained.add(garment.id);
        subtotal = addMoney(subtotal, await addGarment(client, req, req.params.id, garment, index + 1, current.CustomerId, garment.id ?? null));
      }
      if (!hasAtMostPlaces(payload.discount, 2)) throw AppError.badRequest('invalid_discount', 'Discount can have at most 2 decimal places.');
      if (payload.discount > subtotal) throw AppError.badRequest('discount_exceeds_total', 'The discount cannot exceed the order subtotal.');
      const quoted = current.Status === 'Quoted';
      const result = await client.query(`
        UPDATE "Orders" SET "LocationId" = $1, "PromisedDate" = $2::date, "Priority" = $3, "DeliveryMethod" = $4,
          "DeliveryAddress" = $5, "DeliveryInstructions" = $6, "Notes" = $7, "Subtotal" = $8, "Discount" = $9,
          "Total" = $10, "Status" = CASE WHEN "Status" = 'Quoted' THEN 'Draft' ELSE "Status" END,
          "QuotedAtUtc" = CASE WHEN "Status" = 'Quoted' THEN NULL ELSE "QuotedAtUtc" END, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $11 AND "Id" = $12 AND xmin = $13::xid`,
      [payload.locationId, payload.promisedDate, payload.priority, payload.deliveryMethod, clean(payload.deliveryAddress),
        clean(payload.deliveryInstructions), clean(payload.notes), toMoney(subtotal), toMoney(payload.discount),
        toMoney(subtractMoney(subtotal, payload.discount)), businessId, req.params.id, payload.version]);
      if (!result.rowCount) throw AppError.conflict('stale_version', 'This order was changed by someone else. Reload and try again.');
      const removed = [...oldIds].filter((id) => !retained.has(id));
      if (removed.length) await client.query(`DELETE FROM "OrderGarments" WHERE "BusinessId" = $1 AND "Id" = ANY($2::uuid[])`, [businessId, removed]);
      await auditOrder(client, req, 'order.updated', req.params.id, { total: subtotal - payload.discount, requoteRequired: quoted });
      const updated = await loadOrder(client, businessId, req.params.id, allowed);
      await notify(client, {
        businessId, category: 'orders', eventType: 'order.changed', title: 'Order changed',
        body: `Order ${updated.orderNumber} was updated.`, dedupeKey: `order.changed:${req.params.id}:${updated.version}`,
        target: { kind: 'order', id: req.params.id }, recipients: { permission: 'orders.manage', locationId: payload.locationId },
        actorUserId: req.currentUser.userId,
        email: { templateKey: 'order.changed', subject: 'An order was updated', text: () => `Order ${updated.orderNumber} was updated. Open Avzar to review the changes.` },
      });
      return updated;
    });
    return res.status(200).json(order);
  });

  router.post('/orders/:id/amend/preview', ...requireOrdersConfirm, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const payload = parse(updateOrderSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    // Runs the real amendment inside a transaction that is always rolled back, so the preview applies every
    // rule the amendment applies and cannot disagree with it. Nothing is saved, audited or sent.
    const result = await dryRun(pool, (client) => amendOrder(client, req, req.params.id, payload, allowed, { dryRun: true }));
    return res.status(200).json({ preview: true, impact: result.impact });
  });

  router.post('/orders/:id/amend', ...requireOrdersConfirm, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const payload = parse(updateOrderSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    const result = await transaction(pool, (client) => amendOrder(client, req, req.params.id, payload, allowed));
    return res.status(200).json(result);
  });

  router.post('/orders/:id/quote', ...requireOrdersManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    const order = await transaction(pool, async (client) => {
      const { rows } = await client.query(`
        SELECT "Status", "Total" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2
          AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
      [req.currentUser.businessId, req.params.id, allowed]);
      if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
      if (!canTransition(rows[0].Status, 'Quoted')) throw AppError.conflict('invalid_transition', `Only draft orders can be quoted (this one is ${rows[0].Status}).`);
      const garments = await client.query(`SELECT count(*)::int AS "Count" FROM "OrderGarments" WHERE "BusinessId" = $1 AND "OrderId" = $2`,
        [req.currentUser.businessId, req.params.id]);
      if (!garments.rows[0].Count || Number(rows[0].Total) <= 0) throw AppError.badRequest('nothing_to_quote', 'Add priced garments before issuing a quotation.');
      await client.query(`UPDATE "Orders" SET "Status" = 'Quoted', "QuotedAtUtc" = now(), "UpdatedAtUtc" = now() WHERE "BusinessId" = $1 AND "Id" = $2`,
        [req.currentUser.businessId, req.params.id]);
      await auditOrder(client, req, 'order.quoted', req.params.id, { total: Number(rows[0].Total) });
      return loadOrder(client, req.currentUser.businessId, req.params.id, allowed);
    });
    return res.status(200).json(order);
  });

  router.post('/orders/:id/confirm', ...requireOrdersConfirm, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    const order = await transaction(pool, async (client) => {
      const { rows } = await client.query(`
        SELECT o."Status", o."QuotedAtUtc"::text AS "QuotedAtUtc", o."PromisedDate", o."CustomerId", o."OrderNumber", o."LocationId", c."Status" AS "CustomerStatus",
          (now() AT TIME ZONE b."TimeZoneId")::date::text AS "Today"
        FROM "Orders" o
        JOIN "Customers" c ON c."BusinessId" = o."BusinessId" AND c."Id" = o."CustomerId"
        JOIN "Businesses" b ON b."Id" = o."BusinessId"
        WHERE o."BusinessId" = $1 AND o."Id" = $2 AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
        FOR UPDATE OF o`, [req.currentUser.businessId, req.params.id, allowed]);
      if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
      if (!canTransition(rows[0].Status, 'Confirmed')) throw AppError.conflict('invalid_transition', `Only quoted orders can be confirmed (this one is ${rows[0].Status}).`);
      if (String(rows[0].PromisedDate).slice(0, 10) < rows[0].Today) {
        throw AppError.badRequest('promised_date_passed', 'The promised date has passed. Update the order before confirming.');
      }
      if (rows[0].CustomerStatus !== 'Active') throw AppError.conflict('customer_not_active', 'The customer profile is not active.');
      // Only the customer's approval of this exact quotation version authorizes conversion.
      // BusinessId, OrderId and QuotedAtUtc prevent cross-tenant or stale-version approvals.
      const approval = rows[0].QuotedAtUtc ? await client.query(`
        SELECT 1 FROM "QuotationEvents"
        WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "QuotedAtUtc" = $3 AND "Type" = 'Approved'
        LIMIT 1`, [req.currentUser.businessId, req.params.id, rows[0].QuotedAtUtc]) : { rows: [] };
      if (!approval.rows.length) throw AppError.conflict('quotation_not_approved', 'The customer must approve the current quotation before the order can be confirmed.');
      await client.query(`UPDATE "Orders" SET "Status" = 'Confirmed', "ConfirmedAtUtc" = now(), "UpdatedAtUtc" = now() WHERE "BusinessId" = $1 AND "Id" = $2`,
        [req.currentUser.businessId, req.params.id]);
      const plan = await generateProductionTasks(client, req.currentUser.businessId, req.params.id, req.currentUser.userId);
      await auditOrder(client, req, 'order.confirmed', req.params.id, {
        tasksCreated: plan.tasksCreated,
        garmentsWithoutWorkflow: plan.garmentsWithoutWorkflow,
      });
      await notify(client, {
        businessId: req.currentUser.businessId, category: 'orders', eventType: 'order.confirmed', title: 'Order confirmed',
        body: `Order ${rows[0].OrderNumber} was confirmed.`, dedupeKey: `order.confirmed:${req.params.id}`,
        target: { kind: 'order', id: req.params.id },
        recipients: { permission: 'orders.manage', locationId: rows[0].LocationId },
        actorUserId: req.currentUser.userId,
        email: { templateKey: 'order.confirmed', subject: 'An order was confirmed', text: () => `Order ${rows[0].OrderNumber} was confirmed. Open Avzar to review it.` },
      });
      return loadOrder(client, req.currentUser.businessId, req.params.id, allowed);
    });
    return res.status(200).json(order);
  });

  router.post('/orders/:id/cancel', ...requireOrdersManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const payload = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    const order = await transaction(pool, async (client) => {
      const { rows } = await client.query(`
        SELECT "Status", "OrderNumber", "LocationId" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2
          AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
      [req.currentUser.businessId, req.params.id, allowed]);
      if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
      if (rows[0].Status === 'Cancelled') throw AppError.conflict('invalid_transition', 'This order is already cancelled.');
      if (rows[0].Status === 'Delivered') throw AppError.conflict('invalid_transition', 'A delivered order cannot be cancelled. Record a refund instead.');
      if (!canTransition(rows[0].Status, 'Cancelled')) throw AppError.conflict('invalid_transition', `An order that is ${rows[0].Status} cannot be cancelled.`);
      const invoices = await client.query(`SELECT 1 FROM "Invoices" WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" <> 'Void' LIMIT 1`,
        [req.currentUser.businessId, req.params.id]);
      if (invoices.rows.length) throw AppError.conflict('order_has_invoices', 'This order has invoices. Void them first, then cancel the order.');
      const tasks = await client.query(`
        UPDATE "ProductionTasks" SET "Status" = 'Cancelled', "CancelReason" = $1, "UpdatedAtUtc" = now(), "UpdatedByUserId" = $2
        WHERE "BusinessId" = $3 AND "OrderId" = $4 AND "Status" NOT IN ('Completed', 'Cancelled')
        RETURNING "Id", "Status"`, [`Order cancelled: ${payload.reason}`, req.currentUser.userId, req.currentUser.businessId, req.params.id]);
      for (const task of tasks.rows) {
        await client.query(`
          INSERT INTO "TaskEvents" ("Id", "BusinessId", "TaskId", "Type", "FromStatus", "ToStatus", "ActorUserId", "Note", "CreatedAtUtc")
          VALUES ($1, $2, $3, 'cancelled', NULL, 'Cancelled', $4, $5, now())`,
        [randomUUID(), req.currentUser.businessId, task.Id, req.currentUser.userId, `Order cancelled: ${payload.reason}`]);
      }
      await client.query(`
        UPDATE "Orders" SET "Status" = 'Cancelled', "CancelledAtUtc" = now(), "CancellationReason" = $1, "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $2 AND "Id" = $3`, [payload.reason, req.currentUser.businessId, req.params.id]);
      await auditOrder(client, req, 'order.cancelled', req.params.id, { from: rows[0].Status, reason: payload.reason });
      await notify(client, {
        businessId: req.currentUser.businessId, category: 'orders', eventType: 'order.cancelled', title: 'Order cancelled',
        body: `Order ${rows[0].OrderNumber} was cancelled.`, dedupeKey: `order.cancelled:${req.params.id}`,
        target: { kind: 'order', id: req.params.id }, recipients: { permission: 'orders.manage', locationId: rows[0].LocationId },
        actorUserId: req.currentUser.userId,
        email: { templateKey: 'order.cancelled', subject: 'An order was cancelled', text: () => `Order ${rows[0].OrderNumber} was cancelled. Open Avzar to review it.` },
      });
      return loadOrder(client, req.currentUser.businessId, req.params.id, allowed);
    });
    return res.status(200).json(order);
  });

  router.get('/appointments', ...requireOrdersView, async (req, res) => {
    const filters = parseAppointmentListQuery(req.query);
    return res.status(200).json(await listAppointments(pool, req.currentUser, filters, await allowedLocations(pool, req.currentUser)));
  });

  router.get('/appointments/export', ...requireOrdersView, async (req, res) => {
    const filters = parseAppointmentListQuery(req.query); // page and pageSize are checked, then ignored: the export reads every page
    const allowed = await allowedLocations(pool, req.currentUser);
    const { csv } = await exportAppointments(pool, req.currentUser,
      (page, pageSize) => listAppointments(pool, req.currentUser, { ...filters, page, pageSize }, allowed),
      { type: filters.type, status: filters.status, customerId: filters.customerId, orderId: filters.orderId,
        locationId: filters.locationId, assignedMembershipId: filters.assignedMembershipId,
        from: filters.fromUtc?.toISOString(), to: filters.toUtc?.toISOString() });
    return sendCsv(res, 'appointments', csv);
  });

  router.post('/appointments', ...requireFittingsManage, async (req, res) => {
    const payload = parse(appointmentSchema, req.body);
    return res.status(201).json(await createAppointment(pool, transaction, req.currentUser, payload,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/appointments/:id/reschedule', ...requireFittingsManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_appointment_id', 'The appointment ID is invalid.');
    const payload = parse(appointmentIntervalSchema, req.body);
    return res.status(200).json(await rescheduleAppointment(pool, transaction, req.currentUser, req.params.id,
      payload, await allowedLocations(pool, req.currentUser)));
  });

  router.post('/appointments/:id/cancel', ...requireFittingsManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_appointment_id', 'The appointment ID is invalid.');
    const payload = parse(appointmentCancelSchema, req.body);
    return res.status(200).json(await cancelAppointment(pool, transaction, req.currentUser, req.params.id,
      payload.reason, await allowedLocations(pool, req.currentUser)));
  });

  router.post('/appointments/:id/status', ...requireFittingsManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_appointment_id', 'The appointment ID is invalid.');
    const payload = parse(appointmentStatusSchema, req.body);
    return res.status(200).json(await setAppointmentStatus(pool, transaction, req.currentUser, req.params.id,
      payload.status, await allowedLocations(pool, req.currentUser)));
  });

  router.get('/fittings', ...requireOrdersView, async (req, res) => {
    const page = Number.parseInt(req.query.page ?? '1', 10);
    const pageSize = Number.parseInt(req.query.pageSize ?? '25', 10);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
    }
    const filters = { page, pageSize };
    for (const name of ['customerId', 'orderId']) {
      if (req.query[name] !== undefined) {
        if (!isUuid(String(req.query[name]))) throw AppError.badRequest(`invalid_${name}`, `The ${name} is invalid.`);
        filters[name] = String(req.query[name]);
      }
    }
    for (const [queryName, filterName] of [['from', 'fromUtc'], ['to', 'toUtc']]) {
      if (req.query[queryName] !== undefined) {
        const date = new Date(String(req.query[queryName]));
        if (!Number.isFinite(date.getTime())) throw AppError.badRequest(`invalid_${queryName}`, `${queryName} must be a valid date-time.`);
        filters[filterName] = date;
      }
    }
    if (filters.fromUtc && filters.toUtc && filters.toUtc <= filters.fromUtc) {
      throw AppError.badRequest('invalid_date_range', 'The to date must be later than the from date.');
    }
    return res.status(200).json(await listFittings(pool, req.currentUser, filters,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/fittings', ...requireFittingsManage, async (req, res) => {
    const payload = parse(fittingSchema, req.body);
    return res.status(201).json(await createFitting(pool, transaction, req.currentUser, payload,
      await allowedLocations(pool, req.currentUser)));
  });

  router.post('/fittings/:id/status', ...requireFittingsManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_fitting_id', 'The fitting ID is invalid.');
    const payload = parse(fittingStatusSchema, req.body);
    return res.status(200).json(await setFittingStatus(pool, transaction, req.currentUser, req.params.id, payload,
      await allowedLocations(pool, req.currentUser)));
  });

  router.get('/workflows', ...requireTasksView, async (req, res) => {
    const includeInactive = req.query.includeInactive === 'true';
    if (req.query.includeInactive !== undefined && !['true', 'false'].includes(String(req.query.includeInactive))) {
      throw AppError.badRequest('invalid_include_inactive', 'includeInactive must be true or false.');
    }
    const { rows } = await pool.query(`
      SELECT "Id" FROM "Workflows" WHERE "BusinessId" = $1 AND ($2::boolean OR "IsActive") ORDER BY "Name"`,
    [req.currentUser.businessId, includeInactive]);
    const workflows = [];
    for (const row of rows) workflows.push(await loadWorkflow(pool, req.currentUser.businessId, row.Id));
    return res.status(200).json(workflows);
  });

  router.get('/workflows/:id', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_workflow_id', 'The workflow ID is invalid.');
    return res.status(200).json(await loadWorkflow(pool, req.currentUser.businessId, req.params.id));
  });

  router.post('/workflows', ...requireWorkflowsManage, async (req, res) => {
    const payload = parse(workflowSchema, req.body);
    const dependencies = validateWorkflow(payload);
    const workflow = await transaction(pool, (client) => writeWorkflow(client, req, payload, dependencies));
    return res.status(201).json(workflow);
  });

  router.put('/workflows/:id', ...requireWorkflowsManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_workflow_id', 'The workflow ID is invalid.');
    const payload = parse(workflowSchema, req.body);
    const dependencies = validateWorkflow(payload);
    const workflow = await transaction(pool, (client) => writeWorkflow(client, req, payload, dependencies, req.params.id));
    return res.status(200).json(workflow);
  });

  router.get('/workers', ...requireTasksView, async (req, res) => {
    const businessId = req.currentUser.businessId;
    const allowed = await allowedLocations(pool, req.currentUser);
    const { rows: members } = await pool.query(`
      SELECT m."Id", m."DisplayName"
      FROM "Memberships" m
      WHERE m."BusinessId" = $1 AND m."Status" = 0
        AND ($2::uuid[] IS NULL OR EXISTS (
          SELECT 1 FROM "MembershipLocations" ml
          WHERE ml."BusinessId" = m."BusinessId" AND ml."MembershipId" = m."Id"
            AND ml."LocationId" = ANY($2::uuid[])
        ))
      ORDER BY m."DisplayName"`,
    [businessId, allowed]);
    const memberIds = members.map((member) => member.Id);
    const [skills, openTasks] = memberIds.length ? await Promise.all([
      pool.query(`SELECT "MembershipId", "Skill" FROM "WorkerSkills"
        WHERE "BusinessId" = $1 AND "MembershipId" = ANY($2::uuid[]) ORDER BY "Skill"`,
      [businessId, memberIds]),
      pool.query(`
        SELECT t."AssignedMembershipId" AS "MembershipId", count(*)::int AS "OpenTasks"
        FROM "ProductionTasks" t
        JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
        WHERE t."BusinessId" = $1 AND t."AssignedMembershipId" = ANY($2::uuid[])
          AND t."Status" NOT IN ('Completed', 'Cancelled')
          AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
        GROUP BY t."AssignedMembershipId"`,
      [businessId, memberIds, allowed]),
    ]) : [{ rows: [] }, { rows: [] }];
    const skillsByMember = new Map();
    for (const row of skills.rows) {
      const list = skillsByMember.get(row.MembershipId) ?? [];
      list.push(row.Skill);
      skillsByMember.set(row.MembershipId, list);
    }
    const taskCounts = new Map(openTasks.rows.map((row) => [row.MembershipId, Number(row.OpenTasks)]));
    return res.status(200).json(members.map((member) => ({
      membershipId: member.Id,
      displayName: member.DisplayName,
      isActive: true,
      skills: skillsByMember.get(member.Id) ?? [],
      openTasks: taskCounts.get(member.Id) ?? 0,
    })));
  });

  router.put('/workers/:membershipId/skills', ...requireWorkersManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    const { skills: inputSkills } = parse(setWorkerSkillsSchema, req.body);
    const skills = [...new Set(inputSkills.map((skill) => skill.trim().toLowerCase()))];
    const allowed = await allowedLocations(pool, req.currentUser);
    const worker = await transaction(pool, async (client) => {
      const { rows: members } = await client.query(`
        SELECT m."Id", m."DisplayName" FROM "Memberships" m
        WHERE m."BusinessId" = $1 AND m."Id" = $2 AND m."Status" = 0
          AND ($3::uuid[] IS NULL OR EXISTS (
            SELECT 1 FROM "MembershipLocations" ml
            WHERE ml."BusinessId" = m."BusinessId" AND ml."MembershipId" = m."Id"
              AND ml."LocationId" = ANY($3::uuid[])
          ))`,
      [req.currentUser.businessId, req.params.membershipId, allowed]);
      if (!members.length) throw AppError.notFound('staff_not_found', 'Active staff member was not found in your permitted locations.');
      await client.query(`DELETE FROM "WorkerSkills" WHERE "BusinessId" = $1 AND "MembershipId" = $2`,
        [req.currentUser.businessId, req.params.membershipId]);
      for (const skill of skills) {
        await client.query(`
          INSERT INTO "WorkerSkills" ("MembershipId", "Skill", "BusinessId") VALUES ($1, $2, $3)`,
        [req.params.membershipId, skill, req.currentUser.businessId]);
      }
      await client.query(`
        INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc",
          "DetailsJson", "EntityId", "EntityType")
        VALUES ($1, 'worker.skills_changed', $2, $3, now(), $4::jsonb, $5, 'WorkerSkill')`,
      [randomUUID(), req.currentUser.userId, req.currentUser.businessId, JSON.stringify({ skills }), req.params.membershipId]);
      return members[0];
    });
    const { rows: taskRows } = await pool.query(`
      SELECT count(*)::int AS "OpenTasks"
      FROM "ProductionTasks" t
      JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
      WHERE t."BusinessId" = $1 AND t."AssignedMembershipId" = $2
        AND t."Status" NOT IN ('Completed', 'Cancelled')
        AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))`,
    [req.currentUser.businessId, worker.Id, allowed]);
    return res.status(200).json({
      membershipId: worker.Id,
      displayName: worker.DisplayName,
      isActive: true,
      skills,
      openTasks: Number(taskRows[0].OpenTasks),
    });
  });

  router.get('/workers/:membershipId/schedule/availability', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(200).json(await getWorkerAvailability(pool, req.currentUser, req.params.membershipId, allowed));
  });

  router.put('/workers/:membershipId/schedule/availability', ...requireWorkersManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    const { days } = parse(setWorkerAvailabilitySchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(200).json(await setWorkerAvailability(pool, transaction, req.currentUser, req.params.membershipId, days, allowed));
  });

  router.get('/workers/:membershipId/schedule/leave', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    if (typeof req.query.fromUtc !== 'string' || typeof req.query.toUtc !== 'string') {
      throw AppError.badRequest('invalid_calendar_range', 'Provide fromUtc and toUtc as UTC date-times.');
    }
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(200).json(await listWorkerLeave(pool, req.currentUser, req.params.membershipId,
      req.query.fromUtc, req.query.toUtc, allowed));
  });

  router.post('/workers/:membershipId/schedule/leave', ...requireWorkersManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    const payload = parse(workerLeaveSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(201).json(await addWorkerLeave(pool, transaction, req.currentUser, req.params.membershipId, payload, allowed));
  });

  router.delete('/workers/:membershipId/schedule/leave/:leaveId', ...requireWorkersManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    if (!isUuid(req.params.leaveId)) throw AppError.badRequest('invalid_leave_id', 'The leave ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    await cancelWorkerLeave(pool, transaction, req.currentUser, req.params.membershipId, req.params.leaveId, allowed);
    return res.status(204).end();
  });

  router.get('/workers/:membershipId/schedule/leave-requests/pending', ...requireWorkersManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    return res.status(200).json(await listPendingWorkerLeave(pool, req.currentUser, await allowedLocations(pool, req.currentUser)));
  });

  router.post('/workers/:membershipId/schedule/leave-requests/:leaveId/review', ...requireWorkersManage, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    if (!isUuid(req.params.leaveId)) throw AppError.badRequest('invalid_leave_id', 'The leave ID is invalid.');
    const payload = parse(workerLeaveReviewSchema, req.body);
    return res.status(200).json(await reviewWorkerLeave(pool, transaction, req.currentUser, req.params.leaveId,
      payload, await allowedLocations(pool, req.currentUser)));
  });

  router.post('/workers/:membershipId/schedule/calendar-feed', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    // Reuse the calendar authorization check before issuing a durable feed credential.
    await getWorkerCalendar(pool, req.currentUser, req.params.membershipId,
      new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), allowed);
    const { rows: workerLocations } = await pool.query(`
      SELECT ml."LocationId" FROM "MembershipLocations" ml
      JOIN "Memberships" m ON m."Id"=ml."MembershipId" AND m."BusinessId"=ml."BusinessId"
      WHERE ml."BusinessId"=$1 AND ml."MembershipId"=$2 AND m."Status"=0 ORDER BY ml."LocationId"`,
    [req.currentUser.businessId, req.params.membershipId]);
    const targetLocations = workerLocations.map((row) => row.LocationId)
      .filter((id) => allowed === null || allowed.includes(id));
    if (!targetLocations.length) throw AppError.conflict('calendar_feed_no_locations', 'Assign the worker to a permitted location before creating a calendar feed.');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    // The new link and its audit entry commit together. The token itself is never written to the audit entry.
    const feedId = await transaction(pool, async (client) => {
      const { rows } = await client.query(`
        INSERT INTO "CalendarFeedTokens" ("Id","BusinessId","MembershipId","TokenHash","AllowedLocationIds","CreatedAtUtc")
        VALUES ($1,$2,$3,$4,$5,now()) RETURNING "Id"`,
      [randomUUID(), req.currentUser.businessId, req.params.membershipId, tokenHash, targetLocations]);
      await auditCalendarFeed(client, req, 'calendar_feed.created', rows[0].Id, { membershipId: req.params.membershipId, locationCount: targetLocations.length });
      return rows[0].Id;
    });
    return res.status(201).json({ id: feedId, urlPath: `/api/calendar-feeds/${token}.ics`, token });
  });

  router.get('/workers/:membershipId/schedule/calendar-feeds', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    // Same authorization check as creating a feed: the caller must be allowed to see this worker's calendar.
    await getWorkerCalendar(pool, req.currentUser, req.params.membershipId,
      new Date().toISOString(), new Date(Date.now() + 60_000).toISOString(), allowed);
    // Metadata only. The link itself is shown once when it is created and is never stored in readable form.
    const { rows } = await pool.query(`
      SELECT "Id", "CreatedAtUtc", "LastUsedAtUtc", "RevokedAtUtc", "ExpiresAtUtc"
      FROM "CalendarFeedTokens" WHERE "BusinessId" = $1 AND "MembershipId" = $2
      ORDER BY "CreatedAtUtc" DESC LIMIT 20`, [req.currentUser.businessId, req.params.membershipId]);
    return res.status(200).json(rows.map((row) => ({
      id: row.Id, createdAtUtc: row.CreatedAtUtc, lastUsedAtUtc: row.LastUsedAtUtc, revokedAtUtc: row.RevokedAtUtc, expiresAtUtc: row.ExpiresAtUtc,
    })));
  });

  router.delete('/workers/:membershipId/schedule/calendar-feed/:id', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.membershipId) || !isUuid(req.params.id)) throw AppError.badRequest('invalid_calendar_feed', 'The membership or feed ID is invalid.');
    // A user limited to some locations may stop only links that reach at least one of them. Unlike making or listing a link, this
    // does not require the worker to be active, so the link of someone who has since been deactivated can still be stopped.
    const allowed = await allowedLocations(pool, req.currentUser);
    await transaction(pool, async (client) => {
      const result = await client.query(`
        UPDATE "CalendarFeedTokens" SET "RevokedAtUtc" = now()
        WHERE "Id" = $1 AND "BusinessId" = $2 AND "MembershipId" = $3 AND "RevokedAtUtc" IS NULL
          AND ($4::uuid[] IS NULL OR "AllowedLocationIds" && $4::uuid[])`,
      [req.params.id, req.currentUser.businessId, req.params.membershipId, allowed]);
      if (!result.rowCount) throw AppError.notFound('calendar_feed_not_found', 'Calendar feed not found.');
      await auditCalendarFeed(client, req, 'calendar_feed.revoked', req.params.id, { membershipId: req.params.membershipId });
    });
    return res.status(204).end();
  });

  router.get('/calendar-feeds/:token.ics', async (req, res) => {
    const token = String(req.params.token ?? '');
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw AppError.notFound('calendar_feed_not_found', 'Calendar feed not found.');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    // The feed URL is the key; the token row it matches names the business, which is bound before the membership join below.
    await bindTenantByLookup(pool, 'calendar_token_hash', tokenHash);
    const { rows } = await pool.query(`
      UPDATE "CalendarFeedTokens" token SET "LastUsedAtUtc" = now()
      FROM "Memberships" membership
      WHERE token."TokenHash" = $1 AND token."RevokedAtUtc" IS NULL
        AND (token."ExpiresAtUtc" IS NULL OR token."ExpiresAtUtc" > now())
        AND membership."BusinessId"=token."BusinessId" AND membership."Id"=token."MembershipId" AND membership."Status"=0
      RETURNING token."BusinessId",token."MembershipId",token."AllowedLocationIds"`, [tokenHash]);
    const feed = rows[0];
    if (!feed) throw AppError.notFound('calendar_feed_not_found', 'Calendar feed not found.');
    const from = new Date();
    const to = new Date(from.getTime() + 90 * 24 * 60 * 60 * 1000);
    // A calendar URL is a bearer credential, so do not let it preserve access to a location
    // after the worker is unassigned from it. Intersect the issue-time snapshot with current
    // membership locations on every feed request.
    const { rows: currentLocationRows } = await pool.query(`
      SELECT ml."LocationId" FROM "MembershipLocations" ml
      JOIN "Memberships" m ON m."Id"=ml."MembershipId" AND m."BusinessId"=ml."BusinessId"
      WHERE ml."BusinessId"=$1 AND ml."MembershipId"=$2 AND m."Status"=0`,
    [feed.BusinessId, feed.MembershipId]);
    const currentLocationIds = currentLocationRows.map((row) => row.LocationId);
    const effectiveLocationIds = intersectCalendarFeedLocations(currentLocationIds, feed.AllowedLocationIds);
    const user = { businessId: feed.BusinessId };
    const tasks = effectiveLocationIds.length
      ? await getWorkerCalendar(pool, user, feed.MembershipId, from.toISOString(), to.toISOString(), effectiveLocationIds)
      : [];
    const { rows: appointments } = await pool.query(`
      SELECT a."Id", a."Type", a."StartUtc", a."EndUtc"
      FROM "Appointments" a WHERE a."BusinessId" = $1 AND a."AssignedMembershipId" = $2
        AND a."StartUtc" < $4 AND a."EndUtc" > $3 AND a."Status" = 'Scheduled'
        AND a."LocationId" = ANY($5::uuid[])
      ORDER BY a."StartUtc"`, [feed.BusinessId, feed.MembershipId, from, to, effectiveLocationIds]);
    const events = [
      ...tasks.map(taskIcsEvent),
      ...appointments.map(appointmentIcsEvent),
    ];
    const ics = renderIcs(events);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).send(ics);
  });

  router.get('/workers/:membershipId/schedule/calendar.ics', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    if (typeof req.query.fromUtc !== 'string' || typeof req.query.toUtc !== 'string') {
      throw AppError.badRequest('invalid_calendar_range', 'Provide fromUtc and toUtc as UTC date-times.');
    }
    const from = new Date(req.query.fromUtc);
    const to = new Date(req.query.toUtc);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from || to - from > 93 * 24 * 60 * 60 * 1000) {
      throw AppError.badRequest('invalid_calendar_range', 'The calendar range must be valid, increasing, and no longer than 93 days.');
    }
    const allowed = await allowedLocations(pool, req.currentUser);
    const tasks = await getWorkerCalendar(pool, req.currentUser, req.params.membershipId,
      from.toISOString(), to.toISOString(), allowed);
    const { rows: appointments } = await pool.query(`
      SELECT a."Id", a."Type", a."StartUtc", a."EndUtc", a."Status"
      FROM "Appointments" a
      WHERE a."BusinessId" = $1 AND a."AssignedMembershipId" = $2
        AND a."StartUtc" < $4 AND a."EndUtc" > $3
        AND a."Status" = 'Scheduled'
        AND ($5::uuid[] IS NULL OR a."LocationId" = ANY($5::uuid[]))
      ORDER BY a."StartUtc"`, [req.currentUser.businessId, req.params.membershipId, from, to, allowed]);
    const events = [
      ...tasks.map(taskIcsEvent),
      ...appointments.map(appointmentIcsEvent),
    ];
    const ics = renderIcs(events);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="avzar-worker-calendar.ics"');
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).send(ics);
  });

  router.get('/workers/:membershipId/schedule/calendar', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.membershipId)) throw AppError.badRequest('invalid_membership_id', 'The membership ID is invalid.');
    if (typeof req.query.fromUtc !== 'string' || typeof req.query.toUtc !== 'string') {
      throw AppError.badRequest('invalid_calendar_range', 'Provide fromUtc and toUtc as UTC date-times.');
    }
    return res.status(200).json(await getWorkerCalendar(pool, req.currentUser, req.params.membershipId,
      req.query.fromUtc, req.query.toUtc, await allowedLocations(pool, req.currentUser)));
  });

  router.post('/my/leave-requests', ...requireTasksWork, async (req, res) => {
    const payload = parse(workerLeaveSchema, req.body);
    return res.status(201).json(await requestMyLeave(pool, transaction, req.currentUser, payload));
  });

  router.get('/tasks', ...requireTasksView, async (req, res) => {
    const page = Number.parseInt(req.query.page ?? '1', 10);
    const pageSize = Number.parseInt(req.query.pageSize ?? '25', 10);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
    }
    const allowed = await allowedLocations(pool, req.currentUser);
    const values = [req.currentUser.businessId, allowed];
    const filters = ['t."BusinessId" = $1', '($2::uuid[] IS NULL OR o."LocationId" = ANY($2::uuid[]))'];
    const statuses = ['Pending', 'Scheduled', 'InProgress', 'Paused', 'Blocked', 'Completed', 'Cancelled'];
    const priorities = ['Low', 'Normal', 'High', 'Urgent'];
    for (const [field, column, allowedValues] of [
      ['status', 't."Status"', statuses], ['priority', 't."Priority"', priorities],
    ]) {
      if (!isBlank(req.query[field])) {
        values.push(parseEnum(String(req.query[field]), allowedValues, field));
        filters.push(`${column} = $${values.length}`);
      }
    }
    for (const [field, column] of [
      ['orderId', 't."OrderId"'], ['garmentId', 't."OrderGarmentId"'], ['assigneeId', 't."AssignedMembershipId"'],
    ]) {
      if (req.query[field] !== undefined) {
        if (!isUuid(String(req.query[field]))) throw AppError.badRequest(`invalid_${field}`, `The ${field} is invalid.`);
        values.push(String(req.query[field]));
        filters.push(`${column} = $${values.length}`);
      }
    }
    for (const field of ['unassigned', 'overdue', 'eligible']) {
      if (req.query[field] !== undefined) {
        if (!['true', 'false'].includes(String(req.query[field]))) throw AppError.badRequest(`invalid_${field}`, `${field} must be true or false.`);
        const enabled = String(req.query[field]) === 'true';
        if (field === 'unassigned' && enabled) filters.push('t."AssignedMembershipId" IS NULL AND t."Status" NOT IN (\'Completed\', \'Cancelled\')');
        if (field === 'overdue' && enabled) filters.push('t."Status" NOT IN (\'Completed\', \'Cancelled\') AND t."DeadlineUtc" < now()');
        if (field === 'eligible' && enabled) filters.push(`
          t."Status" IN ('Pending', 'Scheduled') AND o."Status" IN (${sqlStatusList(PRODUCTION_ACTIVE)})
          AND NOT EXISTS (
            SELECT 1 FROM "TaskDependencies" d JOIN "ProductionTasks" prerequisite
              ON prerequisite."BusinessId" = d."BusinessId" AND prerequisite."Id" = d."DependsOnTaskId"
            WHERE d."BusinessId" = t."BusinessId" AND d."TaskId" = t."Id"
              AND prerequisite."Status" NOT IN ('Completed', 'Cancelled')
          )`);
      }
    }
    if (req.query.stage !== undefined) {
      values.push(`%${String(req.query.stage).trim().slice(0, 80).replace(/[\\%_]/g, '\\$&')}%`);
      filters.push(`t."StageName" ILIKE $${values.length} ESCAPE E'\\\\'`);
    }
    if (req.query.dueBefore !== undefined) {
      const date = new Date(String(req.query.dueBefore));
      if (Number.isNaN(date.getTime())) throw AppError.badRequest('invalid_due_before', 'dueBefore must be a valid date-time.');
      values.push(date.toISOString());
      filters.push(`t."DeadlineUtc" IS NOT NULL AND t."DeadlineUtc" < $${values.length}::timestamptz`);
    }
    const where = filters.join(' AND ');
    const count = await pool.query(`
      SELECT count(*)::int AS "TotalCount"
      FROM "ProductionTasks" t JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
      WHERE ${where}`, values);
    const { rows } = await pool.query(`
      SELECT ${taskSummaryColumns}
      FROM "ProductionTasks" t
      JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
      JOIN "OrderGarments" g ON g."BusinessId" = t."BusinessId" AND g."Id" = t."OrderGarmentId"
      LEFT JOIN "Memberships" m ON m."BusinessId" = t."BusinessId" AND m."Id" = t."AssignedMembershipId"
      WHERE ${where}
      ORDER BY CASE t."Priority" WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 ELSE 3 END,
        t."DeadlineUtc" IS NULL, t."DeadlineUtc", t."StageOrder"
      LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, pageSize, (page - 1) * pageSize]);
    const now = new Date();
    return res.status(200).json({
      items: rows.map((row) => taskSummary(row, now)),
      page,
      pageSize,
      totalCount: Number(count.rows[0]?.TotalCount ?? 0),
    });
  });

  router.get('/tasks/schedule/versions', ...requireTasksView, async (req, res) => {
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(200).json(await listShopScheduleVersions(pool, req.currentUser, allowed));
  });

  router.post('/tasks/schedule/preview', ...requireTasksView, async (req, res) => {
    const payload = parse(schedulePreviewSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(200).json(await previewShopSchedule(pool, req.currentUser, payload, allowed));
  });

  router.post('/tasks/schedule/apply', ...requireTasksManage, async (req, res) => {
    const payload = parse(scheduleApplySchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    return res.status(200).json(await applyShopSchedule(pool, req.currentUser, payload, allowed, transaction));
  });

  router.get('/tasks/worker-requests', ...requireTasksManage, async (req, res) => {
    const rawStatus = String(req.query.status ?? 'Pending');
    const status = rawStatus === 'all' ? null : parseEnum(rawStatus, ['Pending', 'Accepted', 'Declined'], 'status');
    const allowed = await allowedLocations(pool, req.currentUser);
    await respondList(res, req.query, async (window) => {
      const { rows, totalCount } = await windowedRows((sql, params) => pool.query(sql, params), `
      SELECT r."Id", r."TaskId", r."Type", r."Status", r."Message", r."PlannedMinutes", r."ActualMinutes",
        r."CreatedAtUtc", r."ReviewNote", r."ReviewedAtUtc", t."Title" AS "TaskTitle", t."Status" AS "TaskStatus",
        o."OrderNumber", m."DisplayName" AS "RequestedByName"
      FROM "TaskWorkerRequests" r
      JOIN "ProductionTasks" t ON t."BusinessId" = r."BusinessId" AND t."Id" = r."TaskId"
      JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
      JOIN "Memberships" m ON m."BusinessId" = r."BusinessId" AND m."Id" = r."RequestedByMembershipId"
      WHERE r."BusinessId" = $1 AND ($2::text IS NULL OR r."Status" = $2)
        AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
      ORDER BY CASE WHEN r."Status" = 'Pending' THEN 0 ELSE 1 END, r."CreatedAtUtc" DESC, r."Id"`,
      [req.currentUser.businessId, status, allowed], window);
      return { totalCount, rows: rows.map((r) => ({ id: r.Id, taskId: r.TaskId, type: r.Type, status: r.Status,
        message: r.Message, plannedMinutes: r.PlannedMinutes, actualMinutes: r.ActualMinutes, createdAtUtc: r.CreatedAtUtc,
        reviewNote: r.ReviewNote, reviewedAtUtc: r.ReviewedAtUtc, taskTitle: r.TaskTitle, taskStatus: r.TaskStatus,
        orderNumber: r.OrderNumber, requestedByName: r.RequestedByName })) };
    });
  });

  router.post('/tasks/worker-requests/:id/review', ...requireTasksManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_request_id', 'The request ID is invalid.');
    const payload = parse(reviewTaskWorkerRequestSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    const result = await transaction(pool, (client) => reviewTaskWorkerRequest(client, req, req.params.id, payload,
      allowed));
    return res.status(200).json(result);
  });

  router.get('/tasks/:id', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    return res.status(200).json(await loadTaskDetail(pool, req.currentUser.businessId, req.params.id,
      await allowedLocations(pool, req.currentUser)));
  });

  router.put('/tasks/:id', ...requireTasksManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(updateTaskSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    await transaction(pool, (client) =>
      updateProductionTask(client, req, req.params.id, payload, allowed));
    const detail = await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, allowed);
    publishTaskUpdated(req.currentUser.businessId, detail); // after commit, so a client that refetches sees the change
    return res.status(200).json(detail);
  });

  router.post('/tasks/:id/assign', ...requireTasksAssign, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(assignTaskSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    await transaction(pool, (client) =>
      assignProductionTask(client, req, req.params.id, payload, allowed));
    return res.status(200).json(await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, allowed));
  });

  router.post('/tasks/:id/unblock', ...requireTasksManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(taskNoteSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    await transaction(pool, (client) =>
      transitionProductionTask(client, req, req.params.id, 'unblock', payload, allowed));
    return res.status(200).json(await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, allowed));
  });

  router.post('/tasks/:id/cancel', ...requireTasksManage, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(cancelTaskSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    await transaction(pool, (client) =>
      transitionProductionTask(client, req, req.params.id, 'cancel', payload, allowed));
    return res.status(200).json(await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, allowed));
  });

  router.post('/tasks/:id/override', ...requireTasksOverride, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(overrideTaskSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    await transaction(pool, (client) =>
      transitionProductionTask(client, req, req.params.id, 'override', payload, allowed));
    return res.status(200).json(await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, allowed));
  });

  router.post('/orders/:orderId/tasks', ...requireTasksManage, async (req, res) => {
    if (!isUuid(req.params.orderId)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const payload = parse(createTaskSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    const taskId = await transaction(pool, (client) =>
      createProductionTask(client, req, req.params.orderId, payload, allowed));
    return res.status(201).json(await loadTaskDetail(pool, req.currentUser.businessId, taskId, allowed));
  });

  router.post('/orders/:orderId/generate-tasks', ...requireTasksManage, async (req, res) => {
    if (!isUuid(req.params.orderId)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const payload = parse(generateTasksSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    const result = await transaction(pool, async (client) => {
      const { rows } = await client.query(`
        SELECT "Id" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2
          AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
      [req.currentUser.businessId, req.params.orderId, allowed]);
      if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
      const generated = await generateProductionTasks(client, req.currentUser.businessId, req.params.orderId,
        req.currentUser.userId, payload.workflowOverrides);
      await auditOrder(client, req, 'order.tasks_generated', req.params.orderId, generated);
      return generated;
    });
    return res.status(200).json(result);
  });

  router.post('/orders/:orderId/deliver', ...requireOrdersManage, async (req, res) => {
    if (!isUuid(req.params.orderId)) throw AppError.badRequest('invalid_order_id', 'The order ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    const order = await transaction(pool, async (client) => {
      const { rows } = await client.query(`
        SELECT "Status", "OrderNumber", "LocationId" FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2
          AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
      [req.currentUser.businessId, req.params.orderId, allowed]);
      if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
      if (!canTransition(rows[0].Status, 'Delivered')) {
        throw AppError.conflict('invalid_transition', `Only orders that are Ready can be delivered (this one is ${rows[0].Status}). Finish the production tasks first.`);
      }
      const { rows: openTasks } = await client.query(`
        SELECT count(*)::int AS "Count" FROM "ProductionTasks"
        WHERE "BusinessId" = $1 AND "OrderId" = $2 AND "Status" NOT IN ('Completed', 'Cancelled')`,
      [req.currentUser.businessId, req.params.orderId]);
      if (Number(openTasks[0].Count) > 0) {
        throw AppError.conflict('tasks_incomplete', `${openTasks[0].Count} production task(s) are still open.`);
      }
      await client.query(`
        UPDATE "Orders" SET "Status" = 'Delivered', "DeliveredAtUtc" = now(), "UpdatedAtUtc" = now()
        WHERE "BusinessId" = $1 AND "Id" = $2`, [req.currentUser.businessId, req.params.orderId]);
      await auditOrder(client, req, 'order.delivered', req.params.orderId);
      await notify(client, {
        businessId: req.currentUser.businessId, category: 'orders', eventType: 'order.delivered', title: 'Order delivered',
        body: `Order ${rows[0].OrderNumber} was delivered.`, dedupeKey: `order.delivered:${req.params.orderId}`,
        target: { kind: 'order', id: req.params.orderId }, recipients: { permission: 'orders.manage', locationId: rows[0].LocationId },
        actorUserId: req.currentUser.userId,
        email: { templateKey: 'order.delivered', subject: 'An order was delivered', text: () => `Order ${rows[0].OrderNumber} was delivered. Open Avzar to review it.` },
      });
      return loadOrder(client, req.currentUser.businessId, req.params.orderId, allowed);
    });
    return res.status(200).json(order);
  });

  router.post('/order-garments/:garmentId/request-alterations', ...requireTasksManage, async (req, res) => {
    if (!isUuid(req.params.garmentId)) throw AppError.badRequest('invalid_garment_id', 'The garment ID is invalid.');
    const payload = parse(requestAlterationsSchema, req.body);
    const allowed = await allowedLocations(pool, req.currentUser);
    const taskIds = await transaction(pool, (client) =>
      requestGarmentAlterations(client, req, req.params.garmentId, payload.notes, allowed));
    const details = [];
    for (const taskId of taskIds) {
      details.push(await loadTaskDetail(pool, req.currentUser.businessId, taskId, allowed));
    }
    return res.status(200).json(details);
  });

  router.get('/my/tasks', ...requireTasksWork, async (req, res) => {
    const page = Number.parseInt(req.query.page ?? '1', 10);
    const pageSize = Number.parseInt(req.query.pageSize ?? '25', 10);
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw AppError.badRequest('invalid_paging', 'Page must be positive and pageSize must be between 1 and 100.');
    }
    const show = String(req.query.show ?? 'open').toLowerCase();
    if (!['open', 'all', 'completed'].includes(show)) throw AppError.badRequest('invalid_show', 'show must be open, all, or completed.');
    const { rows: membershipRows } = await pool.query(`
      SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0`,
    [req.currentUser.businessId, req.currentUser.userId]);
    if (!membershipRows.length) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
    const membershipId = membershipRows[0].Id;
    const filters = ['t."BusinessId" = $1', 't."AssignedMembershipId" = $2'];
    if (show === 'completed') filters.push(`t."Status" = 'Completed'`);
    if (show === 'open') filters.push(`t."Status" NOT IN ('Completed', 'Cancelled')`);
    const values = [req.currentUser.businessId, membershipId];
    const where = filters.join(' AND ');
    const count = await pool.query(`SELECT count(*)::int AS "TotalCount" FROM "ProductionTasks" t WHERE ${where}`, values);
    const { rows } = await pool.query(`
      SELECT ${taskSummaryColumns}
      FROM "ProductionTasks" t
      JOIN "Orders" o ON o."BusinessId" = t."BusinessId" AND o."Id" = t."OrderId"
      JOIN "OrderGarments" g ON g."BusinessId" = t."BusinessId" AND g."Id" = t."OrderGarmentId"
      LEFT JOIN "Memberships" m ON m."BusinessId" = t."BusinessId" AND m."Id" = t."AssignedMembershipId"
      WHERE ${where}
      ORDER BY CASE t."Priority" WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 WHEN 'Normal' THEN 2 ELSE 3 END,
        t."DeadlineUtc" IS NULL, t."DeadlineUtc", t."StageOrder"
      LIMIT $3 OFFSET $4`,
    [...values, pageSize, (page - 1) * pageSize]);
    const now = new Date();
    return res.status(200).json({
      items: rows.map((row) => taskSummary(row, now)),
      page,
      pageSize,
      totalCount: Number(count.rows[0]?.TotalCount ?? 0),
    });
  });

  router.get('/my/tasks/:id', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const { rows: membershipRows } = await pool.query(`
      SELECT "Id" FROM "Memberships" WHERE "BusinessId" = $1 AND "UserId" = $2 AND "Status" = 0`,
    [req.currentUser.businessId, req.currentUser.userId]);
    if (!membershipRows.length) throw AppError.forbidden('no_active_membership', 'Your account is not an active member of this business.');
    const { rows } = await pool.query(`
      SELECT 1 FROM "ProductionTasks"
      WHERE "BusinessId" = $1 AND "Id" = $2 AND "AssignedMembershipId" = $3`,
    [req.currentUser.businessId, req.params.id, membershipRows[0].Id]);
    if (!rows.length) throw AppError.notFound('task_not_found', 'Task not found.');
    return res.status(200).json(await loadTaskDetail(pool, req.currentUser.businessId,
      req.params.id, null, false));
  });

  router.post('/my/tasks/:id/start', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    await transaction(pool, (client) => workerTaskAction(client, req, req.params.id, 'start'));
    const detail = await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, null, false);
    publishTaskUpdated(req.currentUser.businessId, detail);
    return res.status(200).json(detail);
  });

  router.post('/my/tasks/:id/pause', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(taskNoteSchema, req.body);
    await transaction(pool, (client) => workerTaskAction(client, req, req.params.id, 'pause', payload));
    const detail = await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, null, false);
    publishTaskUpdated(req.currentUser.businessId, detail);
    return res.status(200).json(detail);
  });

  router.post('/my/tasks/:id/resume', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    await transaction(pool, (client) => workerTaskAction(client, req, req.params.id, 'resume'));
    const detail = await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, null, false);
    publishTaskUpdated(req.currentUser.businessId, detail);
    return res.status(200).json(detail);
  });

  router.post('/my/tasks/:id/complete', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(completeTaskSchema, req.body);
    await transaction(pool, (client) => workerTaskCompletion(client, req, req.params.id, payload));
    const detail = await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, null, false);
    publishTaskUpdated(req.currentUser.businessId, detail);
    return res.status(200).json(detail);
  });

  router.post('/my/tasks/:id/issues', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(reportTaskIssueSchema, req.body);
    await transaction(pool, (client) => workerTaskIssue(client, req, req.params.id, payload));
    const detail = await loadTaskDetail(pool, req.currentUser.businessId, req.params.id, null, false);
    publishTaskUpdated(req.currentUser.businessId, detail);
    return res.status(200).json(detail);
  });

  router.get('/my/tasks/:id/photos', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const membershipId = await getActiveMembershipId(pool, req.currentUser);
    const { rows } = await pool.query(`
      SELECT tp."Id", tp."TaskId", tp."MediaAssetId", tp."Caption", tp."UploadedAtUtc",
        m."OriginalFileName", m."ContentType", m."Width", m."Height", m."SizeBytes"
      FROM "TaskProgressPhotos" tp
      JOIN "MediaAssets" m ON m."BusinessId" = tp."BusinessId" AND m."Id" = tp."MediaAssetId"
      JOIN "ProductionTasks" t ON t."BusinessId" = tp."BusinessId" AND t."Id" = tp."TaskId"
      WHERE tp."BusinessId" = $1 AND tp."TaskId" = $2 AND t."AssignedMembershipId" = $3
      ORDER BY tp."UploadedAtUtc" DESC`,
    [req.currentUser.businessId, req.params.id, membershipId]);
    return res.status(200).json({ items: rows.map((row) => ({ id: row.Id, taskId: row.TaskId, mediaId: row.MediaAssetId, caption: row.Caption, uploadedAtUtc: row.UploadedAtUtc, fileName: row.OriginalFileName, contentType: row.ContentType, width: row.Width, height: row.Height, sizeBytes: Number(row.SizeBytes) })) });
  });

  router.post('/my/tasks/:id/photos', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const { file, fields } = await readMultipart(req, { maxBytes: env.MEDIA_MAX_UPLOAD_BYTES, maxFields: 1, maxParts: 2, allowedFields: ['caption'] });
    const membershipId = await getActiveMembershipId(pool, req.currentUser);
    const { rows: taskRows } = await pool.query(`
      SELECT 1 FROM "ProductionTasks"
      WHERE "BusinessId" = $1 AND "Id" = $2 AND "AssignedMembershipId" = $3`,
    [req.currentUser.businessId, req.params.id, membershipId]);
    if (!taskRows.length) throw AppError.notFound('task_not_found', 'Task not found.');
    const payload = parse(taskProgressPhotoSchema, { caption: fields.caption ?? null });
    const asset = await uploadMedia(pool, env, req.app.locals.objectStorage, req.currentUser, file.bytes, file.fileName, 'TaskProgressPhoto', {
      taskId: req.params.id, membershipId, caption: payload.caption ?? null,
    });
    const photo = asset.photo;
    return res.status(201).json({ id: photo.Id, taskId: photo.TaskId, mediaId: photo.MediaAssetId, caption: photo.Caption, uploadedAtUtc: photo.UploadedAtUtc, fileName: asset.fileName, sizeBytes: asset.sizeBytes });
  });

  async function streamTaskPhoto(req, res, workerOnly) {
    if (!isUuid(req.params.id) || !isUuid(req.params.photoId)) throw AppError.notFound('task_photo_not_found', 'Photo not found.');
    const allowed = workerOnly ? null : await allowedLocations(pool, req.currentUser);
    const membershipId = workerOnly ? await getActiveMembershipId(pool, req.currentUser) : null;
    const file = await openTaskPhoto(pool, req.app.locals.objectStorage, req.currentUser,
      req.params.id, req.params.photoId, req.params.variant, allowed, membershipId);
    res.set('cache-control', 'private, no-store').set('x-content-type-options', 'nosniff');
    res.status(200).type(file.contentType);
    file.content.on('error', (error) => res.destroy(error));
    return file.content.pipe(res);
  }

  // Step 18a: reference images on an order (private to the business; never in the media library or on the storefront).
  const referenceDto = (asset) => ({
    id: asset.reference.Id, orderId: asset.reference.OrderId, mediaId: asset.reference.MediaAssetId, caption: asset.reference.Caption,
    fileName: asset.fileName, width: asset.width, height: asset.height, sizeBytes: asset.sizeBytes, createdAtUtc: asset.reference.CreatedAtUtc,
  });

  async function assertOrderVisible(req) {
    if (!isUuid(req.params.id)) throw AppError.notFound('order_not_found', 'Order not found.');
    const allowed = await allowedLocations(pool, req.currentUser);
    const { rows } = await pool.query(`
      SELECT 1 FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2 AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[]))`,
    [req.currentUser.businessId, req.params.id, allowed]);
    if (!rows.length) throw AppError.notFound('order_not_found', 'Order not found.');
    return allowed;
  }

  function streamReferenceImage(file, res) {
    res.set('cache-control', 'private, no-store').set('x-content-type-options', 'nosniff');
    res.status(200).type(file.contentType);
    file.content.on('error', (error) => res.destroy(error));
    return file.content.pipe(res);
  }

  router.get('/orders/:id/reference-images', ...requireOrdersView, async (req, res) => {
    const allowed = await assertOrderVisible(req);
    const items = await listOrderReferenceImages(pool, req.currentUser, req.params.id, allowed);
    return res.status(200).json({ items, maxImages: MAX_REFERENCE_IMAGES });
  });

  router.post('/orders/:id/reference-images', ...requireOrdersManage, async (req, res) => {
    const allowed = await assertOrderVisible(req);
    const { file, fields } = await readMultipart(req, { maxBytes: env.MEDIA_MAX_UPLOAD_BYTES, maxFields: 1, maxParts: 2, allowedFields: ['caption'] });
    const payload = parse(taskProgressPhotoSchema, { caption: fields.caption ?? null });
    const asset = await uploadMedia(pool, env, req.app.locals.objectStorage, req.currentUser, file.bytes, file.fileName, 'OrderReferenceImage', null,
      { orderId: req.params.id, caption: payload.caption ?? null, allowedLocations: allowed });
    return res.status(201).json(referenceDto(asset));
  });

  router.delete('/orders/:id/reference-images/:imageId', ...requireOrdersManage, async (req, res) => {
    const allowed = await assertOrderVisible(req);
    if (!isUuid(req.params.imageId)) throw AppError.notFound('reference_image_not_found', 'Image not found.');
    await deleteOrderReferenceImage(pool, req.app.locals.objectStorage, req.currentUser, req.params.id, req.params.imageId, allowed);
    return res.status(204).end();
  });

  router.get('/orders/:id/reference-images/:imageId/file/:variant', ...requireOrdersView, async (req, res) => {
    const allowed = await assertOrderVisible(req);
    if (!isUuid(req.params.imageId)) throw AppError.notFound('reference_image_not_found', 'Image not found.');
    const file = await openOrderReferenceImage(pool, req.app.locals.objectStorage, req.currentUser, req.params.id, req.params.imageId, req.params.variant, allowed);
    return streamReferenceImage(file, res);
  });

  // A worker sees the reference images of the order behind a task assigned to them, and nothing else.
  router.get('/my/tasks/:id/reference-images', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const membershipId = await getActiveMembershipId(pool, req.currentUser);
    const items = await listTaskReferenceImages(pool, req.currentUser, req.params.id, membershipId);
    return res.status(200).json({ items });
  });

  router.get('/my/tasks/:id/reference-images/:imageId/file/:variant', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id) || !isUuid(req.params.imageId)) throw AppError.notFound('reference_image_not_found', 'Image not found.');
    const membershipId = await getActiveMembershipId(pool, req.currentUser);
    const file = await openTaskReferenceImage(pool, req.app.locals.objectStorage, req.currentUser, req.params.id, req.params.imageId, req.params.variant, membershipId);
    return streamReferenceImage(file, res);
  });

  router.get('/tasks/:id/photos/:photoId/file/:variant', ...requireTasksView, async (req, res) => streamTaskPhoto(req, res, false));
  router.get('/my/tasks/:id/photos/:photoId/file/:variant', ...requireTasksWork, async (req, res) => streamTaskPhoto(req, res, true));

  router.get('/tasks/:id/photos', ...requireTasksView, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const allowed = await allowedLocations(pool, req.currentUser);
    const { rows } = await pool.query(`
      SELECT tp."Id", tp."TaskId", tp."MediaAssetId", tp."Caption", tp."UploadedAtUtc",
        m."OriginalFileName", m."ContentType", m."Width", m."Height", m."SizeBytes"
      FROM "TaskProgressPhotos" tp
      JOIN "MediaAssets" m ON m."BusinessId" = tp."BusinessId" AND m."Id" = tp."MediaAssetId"
      JOIN "ProductionTasks" t ON t."BusinessId" = tp."BusinessId" AND t."Id" = tp."TaskId"
      JOIN "Orders" o ON o."BusinessId" = tp."BusinessId" AND o."Id" = t."OrderId"
      WHERE tp."BusinessId" = $1 AND tp."TaskId" = $2 AND ($3::uuid[] IS NULL OR o."LocationId" = ANY($3::uuid[]))
      ORDER BY tp."UploadedAtUtc" DESC`,
    [req.currentUser.businessId, req.params.id, allowed]);
    return res.status(200).json({ items: rows.map((row) => ({ id: row.Id, taskId: row.TaskId, mediaId: row.MediaAssetId, caption: row.Caption, uploadedAtUtc: row.UploadedAtUtc, fileName: row.OriginalFileName, contentType: row.ContentType, width: row.Width, height: row.Height, sizeBytes: Number(row.SizeBytes) })) });
  });

  router.post('/my/tasks/:id/requests', ...requireTasksWork, async (req, res) => {
    if (!isUuid(req.params.id)) throw AppError.badRequest('invalid_task_id', 'The task ID is invalid.');
    const payload = parse(taskWorkerRequestSchema, req.body);
    const result = await transaction(pool, (client) => createTaskWorkerRequest(client, req, req.params.id, payload));
    return res.status(201).json(result);
  });

  return router;
}
