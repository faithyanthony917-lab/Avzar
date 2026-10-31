import { randomUUID } from 'node:crypto';
import { AppError } from '../http/errors.js';
import { withTransaction } from './accountService.js';

const defaults = { defaultHourlyRate: '0', overheadPercent: '10', method: 'Margin', targetPercent: '40', taxPercent: '0', roundingStep: '0' };
const decimalPattern = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function fraction(value) {
  const match = decimalPattern.exec(String(value));
  if (!match) throw AppError.badRequest('invalid_pricing', 'A pricing value is not a valid decimal.');
  const sign = match[1] === '-' ? -1n : 1n;
  const decimalPlaces = (match[3] ?? '').length - Number(match[4] ?? 0);
  let numerator = sign * BigInt(`${match[2]}${match[3] ?? ''}`);
  let denominator = 1n;
  if (decimalPlaces > 0) denominator = 10n ** BigInt(decimalPlaces);
  else if (decimalPlaces < 0) numerator *= 10n ** BigInt(-decimalPlaces);
  return { numerator, denominator };
}

function roundDivision(numerator, denominator) {
  const negative = numerator < 0n !== denominator < 0n;
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  let quotient = absoluteNumerator / absoluteDenominator;
  if ((absoluteNumerator % absoluteDenominator) * 2n >= absoluteDenominator) quotient += 1n;
  return negative ? -quotient : quotient;
}

function multiply(left, right) {
  return { numerator: left.numerator * right.numerator, denominator: left.denominator * right.denominator };
}

function add(left, right) {
  return { numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator };
}

const cents = (value) => roundDivision(fraction(value).numerator * 100n, fraction(value).denominator);
const productCents = (left, right) => {
  const result = multiply(fraction(left), fraction(right));
  return roundDivision(result.numerator * 100n, result.denominator);
};
const outputMoney = (value) => Number(value) / 100;
const outputPercent = (numerator, denominator) => Number(roundDivision(numerator * 10_000n, denominator)) / 100;

function percentOfCents(amountCents, percent) {
  const rate = fraction(percent);
  return roundDivision(amountCents * rate.numerator, rate.denominator * 100n);
}

async function getProfileRow(db, businessId) {
  const { rows } = await db.query('SELECT p.*,p.xmin::text::bigint AS "Version" FROM "PricingProfiles" p WHERE p."BusinessId" = $1 LIMIT 1', [businessId]);
  return rows[0] ?? null;
}

export async function getPricingProfile(pool, businessId) {
  const [business, profile] = await Promise.all([
    pool.query('SELECT "CurrencyCode" FROM "Businesses" WHERE "Id" = $1', [businessId]),
    getProfileRow(pool, businessId),
  ]);
  if (!business.rows.length) throw AppError.unauthorized('no_tenant', 'No business in scope.');
  const rules = profile ?? defaults;
  return {
    isConfigured: profile !== null,
    currencyCode: business.rows[0].CurrencyCode,
    defaultHourlyRate: Number(rules.DefaultHourlyRate ?? rules.defaultHourlyRate),
    overheadPercent: Number(rules.OverheadPercent ?? rules.overheadPercent),
    method: rules.Method ?? rules.method,
    targetPercent: Number(rules.TargetPercent ?? rules.targetPercent),
    taxPercent: Number(rules.TaxPercent ?? rules.taxPercent),
    roundingStep: Number(rules.RoundingStep ?? rules.roundingStep),
    version: profile ? Number(profile.Version ?? profile.xmin) : null,
  };
}

function validateRules(rules) {
  if (rules.defaultHourlyRate < 0) throw AppError.badRequest('invalid_pricing_profile', 'Hourly rate cannot be negative.');
  if (rules.overheadPercent < 0 || rules.overheadPercent > 200) throw AppError.badRequest('invalid_pricing_profile', 'Overhead must be between 0% and 200%.');
  if (rules.taxPercent < 0 || rules.taxPercent > 100) throw AppError.badRequest('invalid_pricing_profile', 'Tax must be between 0% and 100%.');
  if (rules.roundingStep < 0 || rules.roundingStep > 1_000_000) throw AppError.badRequest('invalid_pricing_profile', 'Rounding step must be between 0 and 1,000,000.');
  const max = rules.method === 'Margin' ? 95 : 1000;
  if (rules.targetPercent < 0 || rules.targetPercent > max) {
    throw AppError.badRequest('invalid_pricing_profile', rules.method === 'Margin'
      ? 'A margin target must be between 0% and 95% (a 100% margin would need an infinite price).'
      : 'A markup target must be between 0% and 1000%.');
  }
}

export async function savePricingProfile(pool, user, request) {
  const rules = {
    defaultHourlyRate: request.defaultHourlyRate,
    overheadPercent: request.overheadPercent,
    method: request.method,
    targetPercent: request.targetPercent,
    taxPercent: request.taxPercent,
    roundingStep: request.roundingStep,
  };
  validateRules(rules);
  const businessId = user.businessId;
  await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`${businessId}:pricing-profile`]);
    const current = await getProfileRow(client, businessId);
    if (!current && request.version != null) throw AppError.conflict('stale_version', 'The pricing profile no longer exists. Reload and try again.');
    if (current && request.version == null) throw AppError.badRequest('version_required', "Include the pricing profile's current version when updating.");
    const profileId = current?.Id ?? randomUUID();
    if (!current) {
      await client.query(`
        INSERT INTO "PricingProfiles" ("Id","BusinessId","DefaultHourlyRate","OverheadPercent","Method","TargetPercent","TaxPercent","RoundingStep","CreatedAtUtc")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
      [profileId, businessId, rules.defaultHourlyRate, rules.overheadPercent, rules.method, rules.targetPercent, rules.taxPercent, rules.roundingStep]);
    } else {
      const updated = await client.query(`
        UPDATE "PricingProfiles" SET "DefaultHourlyRate" = $1,"OverheadPercent" = $2,"Method" = $3,"TargetPercent" = $4,
          "TaxPercent" = $5,"RoundingStep" = $6,"UpdatedAtUtc" = now()
        WHERE "BusinessId" = $7 AND "Id" = $8 AND xmin::text::bigint = $9`,
      [rules.defaultHourlyRate, rules.overheadPercent, rules.method, rules.targetPercent, rules.taxPercent, rules.roundingStep,
        businessId, current.Id, request.version]);
      if (updated.rowCount !== 1) throw AppError.conflict('stale_version', 'The pricing profile was changed by someone else. Reload and try again.');
    }
    await client.query(`
      INSERT INTO "AuditLogs" ("Id","Action","ActorUserId","BusinessId","CreatedAtUtc","DetailsJson","EntityId","EntityType")
      VALUES ($1,'pricing.profile_saved',$2,$3,now(),$4::jsonb,$5,'PricingProfile')`,
    [randomUUID(), user.userId, businessId, JSON.stringify({ method: rules.method, targetPercent: rules.targetPercent, overheadPercent: rules.overheadPercent }), profileId]);
  });
  return getPricingProfile(pool, businessId);
}

export async function calculatePricing(pool, businessId, input) {
  const [business, profile] = await Promise.all([
    pool.query('SELECT "CurrencyCode" FROM "Businesses" WHERE "Id" = $1', [businessId]),
    getProfileRow(pool, businessId),
  ]);
  if (!business.rows.length) throw AppError.unauthorized('no_tenant', 'No business in scope.');
  const rules = {
    defaultHourlyRate: profile?.DefaultHourlyRate ?? defaults.defaultHourlyRate,
    overheadPercent: profile?.OverheadPercent ?? defaults.overheadPercent,
    method: input.method ?? profile?.Method ?? defaults.method,
    targetPercent: input.targetPercent ?? profile?.TargetPercent ?? defaults.targetPercent,
    taxPercent: profile?.TaxPercent ?? defaults.taxPercent,
    roundingStep: profile?.RoundingStep ?? defaults.roundingStep,
  };
  validateRules({ ...rules, defaultHourlyRate: Number(rules.defaultHourlyRate), overheadPercent: Number(rules.overheadPercent), taxPercent: Number(rules.taxPercent), roundingStep: Number(rules.roundingStep), targetPercent: Number(rules.targetPercent) });
  const complexity = fraction(input.complexityMultiplier ?? 1);
  const materialCents = input.materials.reduce((sum, line) => sum + productCents(line.quantity, line.unitCost), 0n);
  let labourCents = input.labour.reduce((sum, line) => {
    const rate = line.hourlyRate ?? rules.defaultHourlyRate;
    if (Number(line.hours) > 0 && Number(rate) <= 0) throw AppError.badRequest('invalid_pricing', `Labour '${line.task}' has no hourly rate. Enter a rate, or set a default hourly rate in the pricing profile.`);
    return sum + productCents(line.hours, rate);
  }, 0n);
  labourCents = roundDivision(labourCents * complexity.numerator, complexity.denominator);
  const otherCents = input.other.reduce((sum, line) => sum + cents(line.amount), 0n);
  const overheadCents = percentOfCents(materialCents + labourCents, rules.overheadPercent);
  const totalCents = materialCents + labourCents + otherCents + overheadCents;
  if (totalCents <= 0n) throw AppError.badRequest('invalid_pricing', 'Add at least one cost with an amount above zero.');

  const target = fraction(rules.targetPercent);
  let rawCents;
  if (rules.method === 'Markup') {
    rawCents = roundDivision(totalCents * (100n * target.denominator + target.numerator), 100n * target.denominator);
  } else {
    rawCents = roundDivision(totalCents * 100n * target.denominator, 100n * target.denominator - target.numerator);
  }
  let priceCents = rawCents;
  const stepCents = cents(rules.roundingStep);
  if (stepCents > 0n) priceCents = ((rawCents + stepCents - 1n) / stepCents) * stepCents;
  const profitCents = priceCents - totalCents;
  const taxCents = percentOfCents(priceCents, rules.taxPercent);
  const result = {
    materialCost: outputMoney(materialCents), labourCost: outputMoney(labourCents), otherCost: outputMoney(otherCents),
    overheadCost: outputMoney(overheadCents), totalCost: outputMoney(totalCents),
    suggestedPriceBeforeRounding: outputMoney(rawCents), unitPrice: outputMoney(priceCents), profit: outputMoney(profitCents),
    marginPercent: priceCents === 0n ? 0 : outputPercent(profitCents, priceCents),
    markupPercent: totalCents === 0n ? 0 : outputPercent(profitCents, totalCents),
    taxAmount: outputMoney(taxCents), priceIncludingTax: outputMoney(priceCents + taxCents),
  };
  return {
    currencyCode: business.rows[0].CurrencyCode,
    profileConfigured: profile !== null,
    rules: {
      defaultHourlyRate: Number(rules.defaultHourlyRate), overheadPercent: Number(rules.overheadPercent), method: rules.method,
      targetPercent: Number(rules.targetPercent), taxPercent: Number(rules.taxPercent), roundingStep: Number(rules.roundingStep),
    },
    result,
  };
}