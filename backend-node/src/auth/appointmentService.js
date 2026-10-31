import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { notifyAppointmentEvent } from '../notifications/staffEvents.js';

const TYPES = ['Fitting', 'Consultation', 'Collection', 'Delivery'];
const STATUSES = ['Scheduled', 'Completed', 'Cancelled', 'NoShow'];
const ENTITLEMENT_KEY = 'appointments.monthly.max';
const REMINDER_OFFSETS_MINUTES = [1440, 120];

function appointmentDto(row) {
  return {
    id: row.Id,
    type: row.Type,
    customerId: row.CustomerId,
    orderId: row.OrderId,
    locationId: row.LocationId,
    assignedMembershipId: row.AssignedMembershipId,
    startUtc: new Date(row.StartUtc).toISOString(),
    endUtc: new Date(row.EndUtc).toISOString(),
    timeZoneId: row.TimeZoneId,
    status: row.Status,
    notes: row.Notes,
    cancellationReason: row.CancellationReason ?? null,
  };
}

function checkInterval(startValue, endValue, now, allowPast = false) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw AppError.badRequest('invalid_appointment_interval', 'The appointment end must be later than its start.');
  }
  const durationMinutes = (end.getTime() - start.getTime()) / 60_000;
  if (durationMinutes < 5 || durationMinutes > 480) {
    throw AppError.badRequest('invalid_appointment_duration', 'Appointments must be between 5 minutes and 8 hours long.');
  }
  if (!allowPast && start <= now) throw AppError.badRequest('appointment_in_past', 'Appointments must start in the future.');
  return { start, end };
}

async function consumeAppointmentEntitlement(db, businessId) {
  const { rows } = await db.query(`
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
      (SELECT s."PlanId" FROM "Subscriptions" s
        WHERE s."BusinessId" = $1 AND s."Status" <> 'Expired' LIMIT 1),
      (SELECT free."Id" FROM "Plans" free WHERE free."Code" = 'free' LIMIT 1)
    )`, [businessId, ENTITLEMENT_KEY]);
  if (!rows.length) throw new AppError(503, 'plans_not_seeded', 'Subscription plans are not configured on this server.');

  const rawLimit = String(rows[0].Value ?? '').trim();
  const limit = rawLimit === 'unlimited' ? null : (/^\d+$/.test(rawLimit) ? BigInt(rawLimit) : 0n);
  if (limit === 0n) {
    throw new AppError(403, 'plan_limit_reached', 'Your plan does not allow any appointments this month.', {
      entitlement: ENTITLEMENT_KEY, limit: 0, used: 0,
    });
  }

  const { rows: consumed } = await db.query(`
    INSERT INTO "UsageCounters" ("BusinessId", "Key", "PeriodStartUtc", "Count")
    VALUES ($1, $2, date_trunc('month', now()), 1)
    ON CONFLICT ("BusinessId", "Key", "PeriodStartUtc")
    DO UPDATE SET "Count" = "UsageCounters"."Count" + 1
      WHERE $3::bigint IS NULL OR "UsageCounters"."Count" + 1 <= $3::bigint
    RETURNING "Count"`, [businessId, ENTITLEMENT_KEY, limit === null ? null : limit.toString()]);
  if (!consumed.length) {
    const { rows: used } = await db.query(`
      SELECT "Count" FROM "UsageCounters"
      WHERE "BusinessId" = $1 AND "Key" = $2 AND "PeriodStartUtc" = date_trunc('month', now())`, [businessId, ENTITLEMENT_KEY]);
    throw new AppError(403, 'plan_limit_reached', `Your plan allows ${limit} appointments this month, and you have used ${used[0]?.Count ?? 0}. Upgrade to unlock more.`, {
      entitlement: ENTITLEMENT_KEY, limit: Number(limit), used: Number(used[0]?.Count ?? 0),
    });
  }
}

async function lockConflictKeys(db, businessId, customerId, assignedMembershipId) {
  const keys = [`appointment:customer:${businessId}:${customerId}`];
  if (assignedMembershipId) keys.push(`appointment:staff:${businessId}:${assignedMembershipId}`);
  for (const key of keys.sort()) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [key]);
}

async function validateReferences(db, user, payload, allowedLocations) {
  const { rows: customers } = await db.query(`
    SELECT "Status" FROM "Customers" WHERE "BusinessId" = $1 AND "Id" = $2 FOR KEY SHARE`,
  [user.businessId, payload.customerId]);
  if (!customers.length) throw AppError.notFound('customer_not_found', 'Customer not found.');
  if (customers[0].Status !== 'Active') throw AppError.conflict('customer_not_active', 'Appointments can only be booked for active customers.');

  if (allowedLocations !== null && !allowedLocations.includes(payload.locationId)) {
    throw AppError.forbidden('location_forbidden', 'You do not have access to that location.');
  }
  const { rows: locations } = await db.query(`
    SELECT 1 FROM "Locations" WHERE "BusinessId" = $1 AND "Id" = $2 AND "IsActive" FOR KEY SHARE`,
  [user.businessId, payload.locationId]);
  if (!locations.length) throw AppError.badRequest('unknown_location', 'Location not found or inactive.');

  if (payload.orderId) {
    const { rows: orders } = await db.query(`
      SELECT 1 FROM "Orders" WHERE "BusinessId" = $1 AND "Id" = $2 AND "CustomerId" = $3
        AND "LocationId" = $4 AND ($5::uuid[] IS NULL OR "LocationId" = ANY($5::uuid[])) FOR KEY SHARE`,
    [user.businessId, payload.orderId, payload.customerId, payload.locationId, allowedLocations]);
    if (!orders.length) throw AppError.badRequest('unknown_order', 'That order does not exist for this customer and location.');
  }

  if (payload.assignedMembershipId) {
    const { rows: staff } = await db.query(`
      SELECT 1 FROM "Memberships" member
      WHERE member."BusinessId" = $1 AND member."Id" = $2 AND member."Status" = 0
        AND (member."IsOwner"
          OR EXISTS (
            SELECT 1 FROM "MembershipRoles" role
            JOIN "RolePermissions" permission ON permission."BusinessId" = role."BusinessId" AND permission."RoleId" = role."RoleId"
            WHERE role."BusinessId" = member."BusinessId" AND role."MembershipId" = member."Id"
              AND permission."Permission" = 'locations.all')
          OR EXISTS (
            SELECT 1 FROM "MembershipLocations" assigned
            WHERE assigned."BusinessId" = member."BusinessId" AND assigned."MembershipId" = member."Id"
              AND assigned."LocationId" = $3))
      FOR KEY SHARE`, [user.businessId, payload.assignedMembershipId, payload.locationId]);
    if (!staff.length) throw AppError.badRequest('unknown_assignee', 'The assigned staff member is not active in this business.');
  }
}

async function assertNoConflicts(db, { businessId, customerId, assignedMembershipId, start, end, excludeId, allowedLocations }) {
  await lockConflictKeys(db, businessId, customerId, assignedMembershipId);
  const { rows } = await db.query(`
    SELECT a."Id", a."Type", a."CustomerId", a."AssignedMembershipId", a."LocationId", a."StartUtc", a."EndUtc"
    FROM "Appointments" a
    WHERE a."BusinessId" = $1 AND a."Status" = 'Scheduled'
      AND a."StartUtc" < $3 AND a."EndUtc" > $2
      AND ($4::uuid IS NULL OR a."Id" <> $4)
      AND (a."CustomerId" = $5 OR ($6::uuid IS NOT NULL AND a."AssignedMembershipId" = $6))
    ORDER BY a."StartUtc", a."Id" LIMIT 10`,
  [businessId, start, end, excludeId ?? null, customerId, assignedMembershipId ?? null]);
  if (!rows.length) return;
  const conflicts = rows.filter((row) => allowedLocations === null || allowedLocations.includes(row.LocationId)).map((row) => ({
    appointmentId: row.Id,
    type: row.Type,
    startUtc: new Date(row.StartUtc).toISOString(),
    conflictOn: [
      ...(row.CustomerId === customerId ? ['customer'] : []),
      ...(assignedMembershipId && row.AssignedMembershipId === assignedMembershipId ? ['staff'] : []),
    ],
  }));
  throw AppError.conflict('appointment_conflict', 'This time conflicts with another appointment.', { conflicts });
}

async function insertReminderRows(db, user, appointment, now) {
  if (!appointment.AssignedMembershipId) return;
  for (const offsetMinutes of REMINDER_OFFSETS_MINUTES) {
    const dueAt = new Date(new Date(appointment.StartUtc).getTime() - offsetMinutes * 60_000);
    if (dueAt <= now) continue;
    await db.query(`
      INSERT INTO "AppointmentReminders" ("Id", "BusinessId", "AppointmentId", "RecipientMembershipId",
        "AppointmentStartUtc", "OffsetMinutes", "DueAtUtc", "Status", "Attempts", "NextAttemptUtc", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', 0, $7, $8)
      ON CONFLICT ("BusinessId", "AppointmentId", "AppointmentStartUtc", "OffsetMinutes")
      DO UPDATE SET "Status" = 'Pending', "Attempts" = 0, "NextAttemptUtc" = EXCLUDED."NextAttemptUtc",
        "LeaseUntilUtc" = NULL, "LastError" = NULL, "CancelledAtUtc" = NULL, "SentAtUtc" = NULL
      WHERE "AppointmentReminders"."Status" = 'Cancelled'`,
    [randomUUID(), user.businessId, appointment.Id, appointment.AssignedMembershipId,
      appointment.StartUtc, offsetMinutes, dueAt, now]);
  }
}

async function recordAudit(db, user, action, appointmentId, details = null) {
  await db.query(`
    INSERT INTO "AuditLogs" ("Id", "Action", "ActorUserId", "BusinessId", "CreatedAtUtc", "DetailsJson", "EntityId", "EntityType")
    VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, 'Appointment')`,
  [randomUUID(), action, user.userId, user.businessId, details === null ? null : JSON.stringify(details), appointmentId]);
}

async function loadBusinessTimeZone(db, businessId) {
  const { rows } = await db.query(`SELECT "TimeZoneId" FROM "Businesses" WHERE "Id" = $1 AND "IsActive" FOR KEY SHARE`, [businessId]);
  if (!rows.length) throw AppError.notFound('business_not_found', 'Business not found.');
  return rows[0].TimeZoneId;
}

export async function listAppointments(db, user, filters, allowedLocations, { fittingOnly = false } = {}) {
  const values = [user.businessId, allowedLocations];
  const conditions = ['a."BusinessId" = $1', '($2::uuid[] IS NULL OR a."LocationId" = ANY($2::uuid[]))'];
  if (fittingOnly) conditions.push(`a."Type" = 'Fitting'`);
  for (const [name, column] of [
    ['type', 'Type'], ['customerId', 'CustomerId'], ['orderId', 'OrderId'],
    ['locationId', 'LocationId'], ['assignedMembershipId', 'AssignedMembershipId'], ['status', 'Status'],
  ]) {
    if (filters[name]) {
      values.push(filters[name]);
      conditions.push(`a."${column}" = $${values.length}`);
    }
  }
  if (filters.fromUtc) {
    values.push(filters.fromUtc);
    conditions.push(`a."StartUtc" >= $${values.length}`);
  }
  if (filters.toUtc) {
    values.push(filters.toUtc);
    conditions.push(`a."StartUtc" < $${values.length}`);
  }
  const where = conditions.join(' AND ');
  const count = await db.query(`SELECT count(*)::int AS "TotalCount" FROM "Appointments" a WHERE ${where}`, values);
  const { rows } = await db.query(`
    SELECT a."Id", a."Type", a."CustomerId", a."OrderId", a."LocationId", a."AssignedMembershipId",
      a."StartUtc", a."EndUtc", a."TimeZoneId", a."Status", a."Notes", a."CancellationReason"
    FROM "Appointments" a WHERE ${where}
    ORDER BY a."StartUtc", a."Id"
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
  [...values, filters.pageSize, (filters.page - 1) * filters.pageSize]);
  return {
    items: rows.map(appointmentDto), page: filters.page, pageSize: filters.pageSize,
    totalCount: Number(count.rows[0]?.TotalCount ?? 0),
  };
}

export async function createAppointment(pool, dbTransaction, user, payload, allowedLocations, now = new Date()) {
  if (!TYPES.includes(payload.type)) throw AppError.badRequest('invalid_appointment_type', 'The appointment type is invalid.');
  const { start, end } = checkInterval(payload.startAt, payload.endAt, now);
  return dbTransaction(pool, async (db) => {
    const timeZoneId = await loadBusinessTimeZone(db, user.businessId);
    await validateReferences(db, user, payload, allowedLocations);
    await assertNoConflicts(db, {
      businessId: user.businessId, customerId: payload.customerId,
      assignedMembershipId: payload.assignedMembershipId, start, end, allowedLocations,
    });
    await consumeAppointmentEntitlement(db, user.businessId);
    const id = randomUUID();
    const { rows } = await db.query(`
      INSERT INTO "Appointments" ("Id", "BusinessId", "Type", "CustomerId", "OrderId", "LocationId",
        "AssignedMembershipId", "StartUtc", "EndUtc", "TimeZoneId", "Status", "Notes", "CreatedByUserId", "CreatedAtUtc")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Scheduled', $11, $12, $13)
      RETURNING "Id", "Type", "CustomerId", "OrderId", "LocationId", "AssignedMembershipId", "StartUtc", "EndUtc",
        "TimeZoneId", "Status", "Notes", "CancellationReason"`,
    [id, user.businessId, payload.type, payload.customerId, payload.orderId ?? null, payload.locationId,
      payload.assignedMembershipId ?? null, start, end, timeZoneId, payload.notes?.trim() || null, user.userId, now]);
    await insertReminderRows(db, user, rows[0], now);
    await recordAudit(db, user, 'appointment.created', id, { type: payload.type, startUtc: start.toISOString(), endUtc: end.toISOString() });
    await notifyAppointmentEvent(db, 'assigned', { businessId: user.businessId, appointment: rows[0], actorUserId: user.userId, now });
    return appointmentDto(rows[0]);
  });
}

export async function rescheduleAppointment(pool, dbTransaction, user, appointmentId, payload, allowedLocations, now = new Date()) {
  const { start, end } = checkInterval(payload.startAt, payload.endAt, now);
  return dbTransaction(pool, async (db) => {
    const { rows } = await db.query(`
      SELECT "Id", "Type", "CustomerId", "OrderId", "LocationId", "AssignedMembershipId", "StartUtc", "EndUtc",
        "TimeZoneId", "Status", "Notes", "CancellationReason"
      FROM "Appointments" WHERE "BusinessId" = $1 AND "Id" = $2
        AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
    [user.businessId, appointmentId, allowedLocations]);
    const current = rows[0];
    if (!current) throw AppError.notFound('appointment_not_found', 'Appointment not found.');
    if (current.Status === 'Completed') throw AppError.conflict('appointment_closed', 'A completed appointment cannot be rescheduled.');
    await validateReferences(db, user, {
      customerId: current.CustomerId,
      orderId: current.OrderId,
      locationId: current.LocationId,
      assignedMembershipId: current.AssignedMembershipId,
    }, allowedLocations);
    await assertNoConflicts(db, {
      businessId: user.businessId, customerId: current.CustomerId,
      assignedMembershipId: current.AssignedMembershipId, start, end, excludeId: appointmentId, allowedLocations,
    });
    const { rows: updated } = await db.query(`
      UPDATE "Appointments" SET "StartUtc" = $1, "EndUtc" = $2, "TimeZoneId" = $3, "Status" = 'Scheduled',
        "CancellationReason" = NULL, "UpdatedAtUtc" = $4
      WHERE "BusinessId" = $5 AND "Id" = $6
      RETURNING "Id", "Type", "CustomerId", "OrderId", "LocationId", "AssignedMembershipId", "StartUtc", "EndUtc",
        "TimeZoneId", "Status", "Notes", "CancellationReason"`,
    [start, end, current.TimeZoneId, now, user.businessId, appointmentId]);
    await db.query(`UPDATE "AppointmentReminders" SET "Status" = 'Cancelled', "CancelledAtUtc" = $1, "LeaseUntilUtc" = NULL
      WHERE "BusinessId" = $2 AND "AppointmentId" = $3 AND "Status" IN ('Pending', 'Leased')`, [now, user.businessId, appointmentId]);
    await insertReminderRows(db, user, updated[0], now);
    await recordAudit(db, user, 'appointment.rescheduled', appointmentId, {
      previousStartUtc: new Date(current.StartUtc).toISOString(), startUtc: start.toISOString(), endUtc: end.toISOString(),
    });
    await notifyAppointmentEvent(db, 'changed', { businessId: user.businessId, appointment: updated[0], actorUserId: user.userId, now });
    return appointmentDto(updated[0]);
  });
}

export async function cancelAppointment(pool, dbTransaction, user, appointmentId, reason, allowedLocations, now = new Date()) {
  const cancellationReason = String(reason ?? '').trim();
  if (cancellationReason.length < 3 || cancellationReason.length > 500) {
    throw AppError.badRequest('invalid_cancellation_reason', 'Enter a cancellation reason of 3 to 500 characters.');
  }
  return dbTransaction(pool, async (db) => {
    const { rows } = await db.query(`SELECT "Status" FROM "Appointments"
      WHERE "BusinessId" = $1 AND "Id" = $2 AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
    [user.businessId, appointmentId, allowedLocations]);
    if (!rows.length) throw AppError.notFound('appointment_not_found', 'Appointment not found.');
    if (rows[0].Status === 'Completed') throw AppError.conflict('appointment_closed', 'A completed appointment cannot be cancelled.');
    const { rows: updated } = await db.query(`
      UPDATE "Appointments" SET "Status" = 'Cancelled', "CancellationReason" = $1, "UpdatedAtUtc" = $2
      WHERE "BusinessId" = $3 AND "Id" = $4
      RETURNING "Id", "Type", "CustomerId", "OrderId", "LocationId", "AssignedMembershipId", "StartUtc", "EndUtc",
        "TimeZoneId", "Status", "Notes", "CancellationReason"`,
    [cancellationReason, now, user.businessId, appointmentId]);
    await db.query(`UPDATE "AppointmentReminders" SET "Status" = 'Cancelled', "CancelledAtUtc" = $1, "LeaseUntilUtc" = NULL
      WHERE "BusinessId" = $2 AND "AppointmentId" = $3 AND "Status" IN ('Pending', 'Leased')`, [now, user.businessId, appointmentId]);
    await recordAudit(db, user, 'appointment.cancelled', appointmentId, { reason: cancellationReason });
    await notifyAppointmentEvent(db, 'cancelled', { businessId: user.businessId, appointment: updated[0], actorUserId: user.userId, now });
    return appointmentDto(updated[0]);
  });
}

export async function setAppointmentStatus(pool, dbTransaction, user, appointmentId, status, allowedLocations, now = new Date(), legacyCancelReason = null, notes = undefined) {
  if (!STATUSES.includes(status)) throw AppError.badRequest('invalid_appointment_status', 'The appointment status is invalid.');
  if (status === 'Cancelled') return cancelAppointment(pool, dbTransaction, user, appointmentId,
    legacyCancelReason, allowedLocations, now);
  return dbTransaction(pool, async (db) => {
    const { rows } = await db.query(`
      SELECT "Id", "Type", "CustomerId", "OrderId", "LocationId", "AssignedMembershipId", "StartUtc", "EndUtc",
        "TimeZoneId", "Status", "Notes", "CancellationReason"
      FROM "Appointments" WHERE "BusinessId" = $1 AND "Id" = $2
        AND ($3::uuid[] IS NULL OR "LocationId" = ANY($3::uuid[])) FOR UPDATE`,
    [user.businessId, appointmentId, allowedLocations]);
    const current = rows[0];
    if (!current) throw AppError.notFound('appointment_not_found', 'Appointment not found.');
    if (current.Status === 'Completed' && status !== 'Completed') throw AppError.conflict('appointment_closed', 'A completed appointment cannot be reopened.');
    if (['Cancelled', 'NoShow'].includes(current.Status) && ['Completed', 'NoShow'].includes(status)) {
      throw AppError.conflict('appointment_closed', 'Reopen this appointment before recording a final outcome.');
    }
    if (['Completed', 'NoShow'].includes(status) && new Date(current.EndUtc) > now) {
      throw AppError.conflict('appointment_not_ended', 'An appointment cannot be marked complete or no-show before it ends.');
    }
    if (status === 'Scheduled' && current.Status !== 'Scheduled') {
      const { start, end } = checkInterval(current.StartUtc, current.EndUtc, now);
      await assertNoConflicts(db, {
        businessId: user.businessId, customerId: current.CustomerId,
        assignedMembershipId: current.AssignedMembershipId, start, end, excludeId: appointmentId, allowedLocations,
      });
    } else if (!['Scheduled', 'Completed', 'NoShow'].includes(status)) {
      throw AppError.badRequest('invalid_appointment_status', 'Use the cancel endpoint to cancel an appointment.');
    }
    const { rows: updated } = await db.query(`
      UPDATE "Appointments" SET "Status" = $1, "CancellationReason" = NULL,
        "Notes" = COALESCE($2, "Notes"), "UpdatedAtUtc" = $3
      WHERE "BusinessId" = $4 AND "Id" = $5
      RETURNING "Id", "Type", "CustomerId", "OrderId", "LocationId", "AssignedMembershipId", "StartUtc", "EndUtc",
        "TimeZoneId", "Status", "Notes", "CancellationReason"`,
    [status, notes?.trim() || null, now, user.businessId, appointmentId]);
    if (status === 'Scheduled') {
      await insertReminderRows(db, user, updated[0], now);
    } else {
      await db.query(`UPDATE "AppointmentReminders" SET "Status" = 'Cancelled', "CancelledAtUtc" = $1, "LeaseUntilUtc" = NULL
        WHERE "BusinessId" = $2 AND "AppointmentId" = $3 AND "Status" IN ('Pending', 'Leased')`, [now, user.businessId, appointmentId]);
    }
    await recordAudit(db, user, 'appointment.status_changed', appointmentId, { status });
    return appointmentDto(updated[0]);
  });
}

export async function createFitting(pool, dbTransaction, user, payload, allowedLocations, now = new Date()) {
  const start = new Date(payload.scheduledAt);
  const end = new Date(start.getTime() + payload.durationMinutes * 60_000);
  const result = await createAppointment(pool, dbTransaction, user, {
    type: 'Fitting', customerId: payload.customerId, locationId: payload.locationId, orderId: payload.orderId,
    assignedMembershipId: null, startAt: start.toISOString(), endAt: end.toISOString(), notes: payload.notes,
  }, allowedLocations, now);
  return {
    id: result.id, customerId: result.customerId, orderId: result.orderId, locationId: result.locationId,
    scheduledAtUtc: result.startUtc, durationMinutes: Math.round((Date.parse(result.endUtc) - Date.parse(result.startUtc)) / 60_000),
    status: result.status, notes: result.notes,
  };
}

export async function listFittings(db, user, filters, allowedLocations) {
  const result = await listAppointments(db, user, filters, allowedLocations, { fittingOnly: true });
  return {
    ...result,
    items: result.items.map((item) => ({
      id: item.id, customerId: item.customerId, orderId: item.orderId, locationId: item.locationId,
      scheduledAtUtc: item.startUtc,
      durationMinutes: Math.round((Date.parse(item.endUtc) - Date.parse(item.startUtc)) / 60_000),
      status: item.status, notes: item.notes,
    })),
  };
}

export async function setFittingStatus(pool, dbTransaction, user, fittingId, payload, allowedLocations, now = new Date()) {
  const result = await setAppointmentStatus(pool, dbTransaction, user, fittingId, payload.status,
    allowedLocations, now, payload.cancellationReason, payload.notes);
  return {
    id: result.id, customerId: result.customerId, orderId: result.orderId, locationId: result.locationId,
    scheduledAtUtc: result.startUtc,
    durationMinutes: Math.round((Date.parse(result.endUtc) - Date.parse(result.startUtc)) / 60_000),
    status: result.status, notes: result.notes,
  };
}