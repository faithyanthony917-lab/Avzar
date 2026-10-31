import { randomUUID } from 'node:crypto';

/** True when a stop that has not been lifted exists for this channel and address (any business: one sender serves them all). */
export async function isMessagingSuppressed(db, { channel, address }) {
  const { rows } = await db.query(
    'SELECT 1 FROM "MessagingSuppressions" WHERE "Channel" = $1 AND lower("Address") = lower($2) AND "LiftedAtUtc" IS NULL LIMIT 1',
    [channel, address],
  );
  return rows.length > 0;
}

/** Records a standing stop. Safe to repeat: a second stop for the same address changes nothing. */
export async function recordMessagingSuppression(db, { channel, address, source }) {
  await db.query(
    'INSERT INTO "MessagingSuppressions" ("Id","Channel","Address","Source") VALUES ($1,$2,$3,$4) ON CONFLICT ("Channel", lower("Address")) WHERE "LiftedAtUtc" IS NULL DO NOTHING',
    [randomUUID(), channel, address, source],
  );
}

/** Lifts the standing stop, if any. It does not touch any business's consent record. */
export async function liftMessagingSuppression(db, { channel, address }) {
  const result = await db.query(
    'UPDATE "MessagingSuppressions" SET "LiftedAtUtc" = now(), "UpdatedAtUtc" = now() WHERE "Channel" = $1 AND lower("Address") = lower($2) AND "LiftedAtUtc" IS NULL',
    [channel, address],
  );
  return result.rowCount > 0;
}
