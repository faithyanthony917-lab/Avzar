import { randomUUID } from 'node:crypto';
import { STOREFRONT_CONSENT_VERSION } from './storefrontAnalyticsService.js';

/** More distinct paths than this on one storefront and day are counted under "/other", so a client cannot grow the table without bound. */
export const MAX_PATHS_PER_DAY = 500;

/**
 * Storefront analytics provider interface. The default implementation is first-party (this database); tests inject a fake with the same shape.
 *   recordPageView({ businessId, storefrontId, day, path }): Promise<void>   day is a UTC "YYYY-MM-DD"
 *   recordConsent({ businessId, storefrontId, version, decision }): Promise<void>   decision is "accepted" | "rejected"
 *   summary({ businessId, storefrontId | null, fromDay, toDay }): Promise<{ daily: {day, views}[], topPaths: {path, views}[], consent: {accepted, rejected} }>
 * Every method receives the tenant (businessId) and must scope every read and write to it. Nothing here takes or stores an IP address,
 * user agent, referrer or visitor identifier.
 */
export function createPostgresAnalyticsProvider(pool) {
  return {
    async recordPageView({ businessId, storefrontId, day, path }) {
      const { rows } = await pool.query(
        `SELECT count(*)::int AS "Count", COALESCE(bool_or("Path" = $4), FALSE) AS "Known"
         FROM "StorefrontPageViewDaily" WHERE "BusinessId" = $1 AND "StorefrontId" = $2 AND "Day" = $3::date`,
        [businessId, storefrontId, day, path]);
      const known = rows[0]?.Known === true;
      const full = Number(rows[0]?.Count ?? 0) >= MAX_PATHS_PER_DAY;
      const storedPath = known || !full ? path : '/other';
      await pool.query(
        `INSERT INTO "StorefrontPageViewDaily" ("BusinessId", "StorefrontId", "Day", "Path", "Views")
         VALUES ($1, $2, $3::date, $4, 1)
         ON CONFLICT ("StorefrontId", "Day", "Path") DO UPDATE SET "Views" = "StorefrontPageViewDaily"."Views" + 1
         WHERE "StorefrontPageViewDaily"."BusinessId" = $1`,
        [businessId, storefrontId, day, storedPath]);
    },
    async recordConsent({ businessId, storefrontId, version, decision, tokenHash = null, expiresAt = null }) {
      const consentSql = `INSERT INTO "StorefrontConsentRecords" ("Id", "BusinessId", "StorefrontId", "ConsentVersion", "Decision", "DecidedAtUtc")
                          VALUES ($1, $2, $3, $4, $5, now())`;
      if (decision !== 'accepted' || !tokenHash || !expiresAt) {
        await pool.query(consentSql, [randomUUID(), businessId, storefrontId, version, decision]);
        return;
      }
      // The acceptance record and its revocable grant are atomic: never issue an accepted decision without a persisted grant.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(consentSql, [randomUUID(), businessId, storefrontId, version, decision]);
        await client.query(
          `INSERT INTO "StorefrontConsentTokenGrants" ("TokenHash", "BusinessId", "StorefrontId", "ConsentVersion", "ExpiresAtUtc")
           VALUES ($1, $2, $3, $4, $5)`,
          [tokenHash, businessId, storefrontId, version, expiresAt]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async revokeConsentToken({ businessId, storefrontId, tokenHash, now = new Date() }) {
      await pool.query(
        `UPDATE "StorefrontConsentTokenGrants" SET "RevokedAtUtc" = $4
         WHERE "TokenHash" = $1 AND "BusinessId" = $2 AND "StorefrontId" = $3 AND "RevokedAtUtc" IS NULL`,
        [tokenHash, businessId, storefrontId, now]);
    },
    async isConsentTokenActive({ businessId, storefrontId, tokenHash, now = new Date() }) {
      const { rows } = await pool.query(
        `SELECT 1 AS "Active" FROM "StorefrontConsentTokenGrants"
         WHERE "TokenHash" = $1 AND "BusinessId" = $2 AND "StorefrontId" = $3
           AND "ConsentVersion" = $4 AND "ExpiresAtUtc" > $5 AND "RevokedAtUtc" IS NULL`,
        [tokenHash, businessId, storefrontId, STOREFRONT_CONSENT_VERSION, now]);
      return rows.length > 0;
    },
    async summary({ businessId, storefrontId, fromDay, toDay }) {
      const filter = [businessId, fromDay, toDay, storefrontId ?? null];
      const [daily, topPaths, consent] = await Promise.all([
        pool.query(
          `SELECT "Day"::text AS "Day", sum("Views")::int AS "Views" FROM "StorefrontPageViewDaily"
           WHERE "BusinessId" = $1 AND "Day" >= $2::date AND "Day" <= $3::date AND ($4::uuid IS NULL OR "StorefrontId" = $4::uuid)
           GROUP BY "Day" ORDER BY "Day"`, filter),
        pool.query(
          `SELECT "Path", sum("Views")::int AS "Views" FROM "StorefrontPageViewDaily"
           WHERE "BusinessId" = $1 AND "Day" >= $2::date AND "Day" <= $3::date AND ($4::uuid IS NULL OR "StorefrontId" = $4::uuid)
           GROUP BY "Path" ORDER BY sum("Views") DESC, "Path" LIMIT 10`, filter),
        pool.query(
          `SELECT "Decision", count(*)::int AS "Count" FROM "StorefrontConsentRecords"
           WHERE "BusinessId" = $1 AND "DecidedAtUtc" >= $2::date AND "DecidedAtUtc" < ($3::date + 1) AND ($4::uuid IS NULL OR "StorefrontId" = $4::uuid)
           GROUP BY "Decision"`, filter),
      ]);
      const count = (decision) => Number(consent.rows.find((row) => row.Decision === decision)?.Count ?? 0);
      return {
        daily: daily.rows.map((row) => ({ day: row.Day, views: Number(row.Views) })),
        topPaths: topPaths.rows.map((row) => ({ path: row.Path, views: Number(row.Views) })),
        consent: { accepted: count('accepted'), rejected: count('rejected') },
      };
    },
  };
}
