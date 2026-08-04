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

The B2C source-ledger page is at `http://localhost:3000/operations/b2c`. The Admin-only manual reconciliation control is under `http://localhost:3000/admin` → **Integration status**.

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

The event will be stored only if the **Charge itself** contains a valid receipt or billing email. PLAYBOOK does not substitute the attached Stripe Customer email because it can belong to a different or outdated account. If the charge has no configured product reference or mapping, it will deliberately appear as **Unmapped product** and will not count in financial totals.

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
