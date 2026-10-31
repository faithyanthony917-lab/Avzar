import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../http/errors.js';
import { requireBearerAuth } from '../security/bearerAuth.js';
import { requirePermission } from '../security/permissions.js';
import {
  OPT_OUT_RESERVED_CHARACTERS, TEMPLATE_BODY_MAX, TEMPLATE_CATALOG, TEMPLATE_CHANNELS, TEMPLATE_KINDS,
  isTemplateChannel, isTemplateKind, renderTemplate, validateTemplateBody,
} from '../messaging/templateCatalog.js';

// Step 16c: a business edits the wording of the messages its customers receive. Customer text only; staff notices are not editable.
const bodySchema = z.object({ body: z.string().max(4000) });

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, 'validation_failed', 'One or more fields are invalid.', { errors: { body: ['Write the message text.'] } });
  return result.data;
}

function checked(kind, input) {
  const result = validateTemplateBody(kind, input);
  if (!result.ok) throw new AppError(400, 'validation_failed', 'The message text is not valid.', { errors: { body: result.errors } });
  return result.body;
}

async function tx(pool, businessId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.business_id', $1, true)", [businessId]);
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const audit = (db, { userId, businessId, kind, channel, action }) => db.query(
  'INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType") VALUES ($1,\'message_template.changed\',$2,$3,now(),$4::jsonb,$5,\'MessageTemplate\')',
  [randomUUID(), userId, businessId, JSON.stringify({ kind, channel, action }), businessId],
);

export function createMessageTemplateRouter({ env, pool }) {
  const router = Router();
  const settings = [requireBearerAuth(env, pool), requirePermission('business.settings')];

  function target(req) {
    const { kind, channel } = req.params;
    if (!isTemplateKind(kind)) throw AppError.badRequest('invalid_message_kind', 'Unknown message kind.');
    if (!isTemplateChannel(channel)) throw AppError.badRequest('invalid_messaging_channel', 'Channel must be WhatsApp or SMS.');
    return { kind, channel };
  }

  router.get('/business/message-templates', ...settings, async (req, res) => {
    const businessId = req.currentUser.businessId;
    const rows = await tx(pool, businessId, async (db) => (await db.query('SELECT "Kind","Channel","Body","UpdatedAtUtc" FROM "NotificationTemplates" WHERE "BusinessId"=$1', [businessId])).rows);
    const saved = new Map(rows.map((row) => [`${row.Kind}/${row.Channel}`, row]));
    res.json({
      maxLength: TEMPLATE_BODY_MAX,
      optOutReservedCharacters: OPT_OUT_RESERVED_CHARACTERS,
      items: TEMPLATE_KINDS.map((kind) => {
        const entry = TEMPLATE_CATALOG[kind];
        return {
          kind, label: entry.label, description: entry.description, defaultBody: entry.default,
          placeholders: Object.entries(entry.placeholders).map(([name, description]) => ({ name, description })),
          channels: TEMPLATE_CHANNELS.map((channel) => {
            // Step 16d: WhatsApp is sent as a Meta-approved template, so its wording is fixed (a row saved earlier is ignored when sending).
            if (channel === 'WhatsApp') return { channel, customBody: null, usingDefault: true, fixed: true, updatedAtUtc: null };
            const row = saved.get(`${kind}/${channel}`);
            return { channel, customBody: row?.Body ?? null, usingDefault: !row, updatedAtUtc: row?.UpdatedAtUtc ?? null };
          }),
        };
      }),
    });
  });

  router.put('/business/message-templates/:kind/:channel', ...settings, async (req, res) => {
    const { kind, channel } = target(req);
    if (channel === 'WhatsApp') throw AppError.conflict('whatsapp_wording_fixed', 'WhatsApp messages use wording approved by Meta, so it cannot be changed here.');
    const body = checked(kind, parse(bodySchema, req.body).body);
    const businessId = req.currentUser.businessId;
    const saved = await tx(pool, businessId, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO "NotificationTemplates" ("Id","BusinessId","Kind","Channel","Body","UpdatedByUserId")
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT ("BusinessId","Kind","Channel") DO UPDATE SET "Body"=EXCLUDED."Body","UpdatedByUserId"=EXCLUDED."UpdatedByUserId","UpdatedAtUtc"=now()
         RETURNING "Kind","Channel","Body","UpdatedAtUtc"`,
        [randomUUID(), businessId, kind, channel, body, req.currentUser.userId],
      );
      await audit(db, { userId: req.currentUser.userId, businessId, kind, channel, action: 'saved' });
      return rows[0];
    });
    res.json({ kind: saved.Kind, channel: saved.Channel, customBody: saved.Body, usingDefault: false, updatedAtUtc: saved.UpdatedAtUtc });
  });

  router.delete('/business/message-templates/:kind/:channel', ...settings, async (req, res) => {
    const { kind, channel } = target(req);
    const businessId = req.currentUser.businessId;
    await tx(pool, businessId, async (db) => {
      const { rowCount } = await db.query('DELETE FROM "NotificationTemplates" WHERE "BusinessId"=$1 AND "Kind"=$2 AND "Channel"=$3', [businessId, kind, channel]);
      if (rowCount) await audit(db, { userId: req.currentUser.userId, businessId, kind, channel, action: 'reset' });
    });
    res.json({ kind, channel, customBody: null, usingDefault: true, updatedAtUtc: null });
  });

  // Renders a wording with sample data and saves nothing, so staff see what customers will read before they save.
  router.post('/business/message-templates/:kind/preview', ...settings, async (req, res) => {
    const { kind } = req.params;
    if (!isTemplateKind(kind)) throw AppError.badRequest('invalid_message_kind', 'Unknown message kind.');
    const body = checked(kind, parse(bodySchema, req.body).body);
    const name = await tx(pool, req.currentUser.businessId, async (db) => (await db.query('SELECT "Name" FROM "Businesses" WHERE "Id"=$1', [req.currentUser.businessId])).rows[0]?.Name);
    const sample = { ...TEMPLATE_CATALOG[kind].sample, business: name || TEMPLATE_CATALOG[kind].sample.business };
    const text = renderTemplate(body, sample);
    res.json({ text, characters: text.length, charactersWithOptOut: text.length + OPT_OUT_RESERVED_CHARACTERS });
  });

  return router;
}
