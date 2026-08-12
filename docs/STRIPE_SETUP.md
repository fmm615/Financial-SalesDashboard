# Stripe B2C Setup

PLAYBOOK reads Stripe B2C payments and refunds. It never writes to Stripe.

## 1. Add local server-only values

In `.env.local`, add the two values you have:

```text
STRIPE_API_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRODUCT_REFERENCE_METADATA_KEY=product_id
```

Do not add `NEXT_PUBLIC_` to any of these names and never commit `.env.local`.

`STRIPE_PRODUCT_REFERENCE_METADATA_KEY` must be the name of the metadata field on your Stripe Charge that identifies a product. `product_id` is only the default; change it if your Stripe records use a different key. Without an approved product mapping, a payment is stored for traceability but excluded from financial totals.

## 2. Run the application locally

```bash
npm run dev
```

The B2C source-ledger page is at `http://localhost:3000/operations/b2c`. The Admin-only 48-hour reconciliation and historical backfill controls are under `http://localhost:3000/admin` → **Integration status**. Run the historical backfill once to import existing Stripe history; then use reconciliation to keep the most recent 48 hours current.

## 3. Forward Stripe test events locally

Install and sign in to the Stripe CLI, then run:

```bash
stripe listen --forward-to http://localhost:3000/api/webhooks/stripe
```

The CLI prints a local `whsec_...` value. Use that CLI value for `STRIPE_WEBHOOK_SECRET` while forwarding locally; it is different from an endpoint secret created in the Stripe Dashboard. Restart `npm run dev` after changing `.env.local`.

For a safe test event:

```bash
stripe trigger charge.succeeded
```

PLAYBOOK reads transaction contacts from the **Charge**, a completed Checkout
Session, and a finalized Invoice snapshot. It may display current Payment Method
or Customer-profile contact as a clearly labelled fallback, but mutable fallback
data never makes a payment reportable or changes duplicate matching. A charge
without a valid transaction email remains flagged **Missing customer email**.
If the charge has no configured product reference or mapping, it remains
**Unmapped product**. These records stay excluded until the required review is
completed.

The integration also reads the referenced Balance Transaction for Admin-only
fee and settlement reconciliation. Every Stripe request is HTTP GET. PLAYBOOK
has no Stripe create, update, refund, email, metadata-write, or delete method.

If a Stripe secret is ever printed in terminal or tool output, rotate it in the
Stripe Dashboard and replace the server-only value before live testing. Never
print `.env.local` values while checking configuration.

## 4. Configure the production endpoint later

When PLAYBOOK has a production HTTPS URL, create a Stripe Dashboard endpoint:

```text
https://your-production-domain/api/webhooks/stripe
```

Subscribe to:

- `charge.succeeded`
- `charge.failed`
- `refund.created`
- `refund.updated`

Copy that endpoint's signing secret into the production environment as `STRIPE_WEBHOOK_SECRET`. Do not point a Stripe Dashboard endpoint at `localhost`; Stripe cannot reach it.

## 5. Product mapping and review

Before a payment can count in B2C totals, an Admin must map the provider product reference to an approved category and optional membership tier. Duplicates, failed payments, refunds, and unmapped products remain visible in the B2C ledger and Review Queue for traceability.

The daily job should call `/api/internal/reconcile/stripe` with the `Authorization: Bearer <INTEGRATION_CRON_SECRET>` header. It re-reads the last 48 hours, using provider IDs and content fingerprints to avoid double-counting.

After deploying enrichment, restart the historical backfill from Admin to
revisit existing Charge IDs. Validate a small sample against the Stripe Charges
CSV by exact `ch_...` ID. Compare only safe match/missing/conflict counts in
logs; never print customer contacts, card data, addresses, raw payloads, or
credentials.
