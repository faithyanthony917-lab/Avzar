# WhatsApp setup (step-16d)

How customers receive WhatsApp messages from Avzar, and what the platform owner must do once before they work. **Nothing here has been verified with live credentials** (step-20).

## How it works

- One WhatsApp Business number (Meta Cloud API) serves every shop, as one Twilio number serves SMS. A message names the shop inside its text.
- Meta lets a business start a conversation only with a **message template it approved in advance**. Free text works only within 24 hours of the customer's last message, which our messages never are. So Avzar sends four fixed templates, one per message kind. A shop's own wording (settings, "Customer messages") applies to SMS only; the WhatsApp tab there is read-only.
- Each template is filled from the same facts as the SMS text. The **last variable is always the customer's personal unsubscribe link** (or the words "reply STOP" if no link can be made).
- Only customers with a current `OptedIn` record and no standing stop are messaged (consent is checked when queued and again just before sending), exactly as for SMS.
- A customer who replies **STOP** (also UNSUBSCRIBE, CANCEL, END, QUIT, STOPALL; capitals, spaces and a final full stop do not matter) is stopped for **every shop** that holds that number, on WhatsApp only. **START** lifts only that stop; it never restores a consent a customer withdrew.

## One-time setup

1. In Meta Business Manager, create the four templates below. Category **Utility**, language **English** (code `en`, or set `META_WHATSAPP_TEMPLATE_LANGUAGE` to the code you used, for example `en_GB`). The names and bodies must match exactly; a test fails if this file and the code disagree. Sample values are for Meta's review form.
2. Wait for approval. Until a template is approved, Meta refuses it and that kind of message fails with code `whatsapp_meta_132001` (it is not retried).
3. Set these on the API service: `META_WHATSAPP_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID` (sending), `META_WHATSAPP_APP_SECRET` (checks the signature of inbound messages), `META_WHATSAPP_VERIFY_TOKEN` (any long random string you choose; Meta sends it back once to prove the address), optionally `META_WHATSAPP_TEMPLATE_LANGUAGE` and `META_GRAPH_API_VERSION`.
4. In the Meta app's WhatsApp settings, set the webhook callback URL to `<API address>/api/messaging/whatsapp/webhook` and the verify token to the same string, then subscribe to the **messages** field. Without the app secret and verify token the address answers 503 and STOP replies are not read.
5. Test with your own number only: opt it in on a test customer, trigger a message, reply STOP, and check the stop in the customer's message panel.

## The four templates

### `avzar_appointment_reminder` (appointment reminder)

Body:

```
Reminder from {{1}}: your {{2}} appointment is {{3}} ({{4}}). Reply to the business if you need to make changes. To stop these messages, reply STOP or use this link: {{5}}. Thank you.
```

Sample values: {{1}} = Taratara Atelier; {{2}} = fitting; {{3}} = tomorrow; {{4}} = 22 Oct 2026, 10:00; {{5}} = https://app.example.com/unsubscribe#sample-token

### `avzar_order_amended` (order changed)

Body:

```
Update from {{1}}: order {{2}} was changed. Promised date: {{3}}. Total: {{4}}. Reply to the business if you have questions. To stop these messages, reply STOP or use this link: {{5}}. Thank you.
```

Sample values: {{1}} = Taratara Atelier; {{2}} = ORD-2026-0042; {{3}} = 12 Nov 2026; {{4}} = NGN 45000.00; {{5}} = https://app.example.com/unsubscribe#sample-token

### `avzar_order_ready` (order ready)

Body:

```
Good news from {{1}}: order {{2}} is ready. {{3}} To stop these messages, reply STOP or use this link: {{4}}. Thank you.
```

Sample values: {{1}} = Taratara Atelier; {{2}} = ORD-2026-0042; {{3}} = It is ready for collection.; {{4}} = https://app.example.com/unsubscribe#sample-token

### `avzar_payment_receipt` (payment receipt)

Body:

```
Receipt {{1}} from {{2}}: we received {{3}} for invoice {{4}}. {{5}} To stop these messages, reply STOP or use this link: {{6}}. Thank you.
```

Sample values: {{1}} = RCT-2026-00007; {{2}} = Taratara Atelier; {{3}} = NGN 20000.00; {{4}} = INV-2026-00003; {{5}} = Balance remaining: NGN 25000.00.; {{6}} = https://app.example.com/unsubscribe#sample-token

## Failure codes

Only the numeric Meta code is stored (never the response text). Shown to staff on a failed message in the customer's message panel. To be confirmed against a live account in step 20.

| Stored code | Meaning | Retried |
|---|---|---|
| `recipient_opted_out` (Meta 131050) | The person stopped messages from this number | No: recorded as a stop |
| `whatsapp_meta_132000`, `132001`, `132005`, `132007`, `132012`, `132015`, `132016` | Template missing, not approved, or its variables do not match | No |
| `whatsapp_meta_131047`, `131026`, `131030` | Outside the 24-hour window, undeliverable, or number not allowed (test mode) | No |
| `whatsapp_meta_130429`, `131056`, `80007` | Rate limited | Yes |
| `whatsapp_http_<status>` | Any other failure without a Meta code | Yes for 429 and 5xx |

## Not covered

- No confirmation reply to STOP or START (it needs an outbound message). Meta's own display is the only acknowledgement.
- Delivery receipts (sent, delivered, read) from Meta are ignored.
- One language (English) for all shops.
- No quick-reply "Stop" button on the templates; the customer replies STOP or uses the link.
