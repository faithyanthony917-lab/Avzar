# Step 4: behavioral parity notes (C# to Node)

Written alongside the Step 4 parity patch. "Verified" means a CI run proved it.

## Changed in this patch (awaiting CI)

- **Enums are read like C# `Parse.Value`**: trimmed, case-insensitive, canonical spelling stored. New helpers in
  `src/http/enums.js` (`matchEnum`, `parseEnum`, `isBlank`) and `src/http/ciEnum.js` (Zod). Applied to customer status,
  communication channel and direction, fitting status, design kind/status/visibility, collection visibility, pricing method,
  inquiry kind/status, media purpose, document kind, and the order and task list filters. A blank query filter is ignored.
  An unknown query or service value is `400 invalid_<field>`. Customer status `Merged` is `400 invalid_status`, as in C#.
- **Order garment pricing** is ported: `pricing` and `priceOverrideReason` on each order garment. Needs the `pricing.view`
  permission (or owner), recomputes the unit price with the calculator, stores `PricingSnapshotJson`, and raises
  `override_reason_required`, `override_without_pricing` and `permission_denied` like C#.
- **Order update keeps frozen snapshots**: a line keeps its measurement snapshot unless a different profile or revision is
  picked, keeps its design snapshot unless a different design is picked, and keeps its pricing snapshot unless the manual
  price changed. Before this, every update re-snapshotted the current measurement revision and design price.
- A measurement revision that does not exist is `unknown_revision`; a revision without a profile is ignored (as in C#).

## Compared and found equal

All 97 C# request types against the Node Zod schemas: field lengths and numeric ranges match (branding limits are applied
after trimming, on purpose).

## Left as is on purpose

- Body enum errors use Zod's 400 body, not C#'s `invalid_<field>`.
- Malformed ID in the URL: Node 400, C# 404.
- Node defaults omitted `kind` (design, inquiry), `visibility` (collection) and `method` (pricing); C# requires them.
- Payment `method` accepts `bank_transfer` style spellings (a superset of C#); `finance.test.js` depends on it.
- C# also accepts numeric enum strings such as "1" and comma lists; Node does not.
- Trimming order: Node trims before length checks, C# checks the raw string.

## Not compared

Response DTO shapes, list filters beyond enums, and location-scope 404s for routes other than tasks, invoices and payments.
Reports, billing, admin, staff and storefront query handling were not compared line by line.
