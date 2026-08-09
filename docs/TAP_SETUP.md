# Tap B2C setup

PLAYBOOK reads Tap. It never creates, changes, refunds, or deletes Tap records.

## 1. Add server-only variables

Add these to `.env.local`:

```text
TAP_API_KEY=sk_...
TAP_PRODUCT_REFERENCE_METADATA_KEY=product_id
```

The key must never use a `NEXT_PUBLIC_` prefix and must never be committed. Set the metadata key to the actual stable product reference sent by your Tap checkout. Use `product` only if Tap's direct product field is the stable reference you want to map.

## 2. Run the database migration

In Supabase SQL Editor run:

```text
supabase/migrations/20260805120000_tap_b2c_mapping.sql
```

This creates a local Tap product-mapping function and an index. It makes no connection to Tap and changes no Tap data.

## 3. Start the app and import

Restart `npm run dev`, then open **Admin → Integration status**:

1. Select **Sync Tap now** to read the last 48 hours.
2. Select **Start or restart historical Tap import** to load prior Tap charges/refunds in resumable pages.

Tap list endpoints use a `POST` request only to submit a query. PLAYBOOK's Tap client permits only `/v2/charges/list`, `/v2/refunds/list`, and `/v2/charges/{id}` retrieval; it has no write endpoints.

## 4. Optional webhook

Configure Tap to deliver its signed webhook to:

```text
https://your-domain.example/api/webhooks/tap
```

Tap cannot deliver to `localhost`; use a temporary HTTPS tunnel for local testing. PLAYBOOK validates the `hashstring` according to Tap's documented signature construction before it persists the event. A webhook only records the posted event locally and never performs a Tap write.

## Reporting rule

Tap payments/refunds in non-USD are held for review because PLAYBOOK has no Finance-approved Tap FX source. Add a Finance-approved FX policy/source before allowing non-USD Tap amounts into USD financial totals.
