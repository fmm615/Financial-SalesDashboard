# Optional Provider Product Category Design

**Date:** 2026-08-24

**Status:** Approved for implementation planning

**Supersedes:** The provider-product-mapping requirement in `2026-08-18-b2c-single-control-flow.md` and the related mapping assumptions retained by `2026-08-20-b2c-audit-remediation.md`.

## Goal

A valid completed Stripe or Tap payment must not be excluded from B2C revenue merely because it has no PLAYBOOK product mapping. The ledger will keep showing the provider's original description as the source product label. Category remains optional metadata for provider payments rather than a reporting prerequisite.

## Approved business rule

- A succeeded provider payment may be reportable without `product_mapping_id` and with `category_code = 'unmapped'` when it passes every other reporting rule.
- The original Stripe or Tap description is the visible product label. It is source evidence and is never rewritten or silently converted into a normalized PLAYBOOK category.
- `unmapped_product` is retired as a live blocker, issue, filter, badge, and Work-queue item.
- Product mapping is removed from the live Admin workflow. Existing mapping records, past classifications, financial corrections, review flags, and audit history remain retained.
- Duplicate protection remains mandatory. Unclassified provider payments continue using the stable internal `unmapped` category in the existing fingerprint formula; free-text descriptions do not become identity keys.
- Manual bank transfers and Finance Tracker rows keep their existing explicit-category requirements. This change applies only to Stripe and Tap provider payments.

## Data and reporting behavior

For a new provider payment, ingestion preserves the validated provider description in source metadata and uses `unmapped` as the internal fallback category. It no longer looks up a reusable product mapping and no longer creates an `unmapped_product` review flag.

For an existing provider payment, a webhook or reconciliation re-delivery must preserve any already-retained `product_mapping_id`, category, and tier. Removing the live workflow must not erase historical classifications. No migration deletes or rewrites existing `product_mappings`, payments, corrections, or audit rows.

The shared B2C reportability gate ignores both an `unmapped` category and any historical open `unmapped_product` flag. Succeeded payments still require every other approved condition, including a known USD amount or Finance-approved conversion, valid source status, customer-email rule or controlled exception, and no unresolved duplicate or other blocking review.

Historical `unmapped_product` flags remain immutable evidence in PostgreSQL but are treated as retired policy artifacts. Live repositories exclude them from open issue counts, Work queues, filters, badges, and generic Review Queue results. They are not mass-resolved under an invented Admin actor and are not deleted.

The generic Review Queue may still return one of those historical flags by its exact retained ID for audit-history inspection, but it cannot list it as current work or accept a new mapping action from that detail.

## Admin and UI behavior

- Remove the `Create reusable product mapping` drawer action and its form.
- Remove `Map this`, `Unmapped product`, and the related Issue filter from B2C Work and Ledger surfaces.
- Remove the unmapped-product exclusion count from the live B2C dashboard contract and `Why totals differ`; it is no longer an exclusion.
- Continue displaying `sourceDescription` in ledger rows, cards, and source evidence.
- If the provider supplied no description, display `—`; do not guess a label.
- Keep optional locally corrected category/tier values visible where already supported, but do not require them for ordinary provider-payment reportability.
- A Finance inclusion exception used for a genuinely missing provider email no longer requires a category solely to bypass the retired mapping rule. Its provider-ID confirmation, duplicate confirmation, USD/date requirements, Admin actor, and audit reason remain mandatory.

## API and ownership cleanup

Remove the live `/api/admin/b2c/products/map` route, product-mapping request contract, drawer submission logic, and tests that exist only for that action after confirming they have no other callers. Database mapping tables and protected mapping functions remain for historical compatibility, but a forward migration revokes their write permissions so they cannot remain an undocumented alternate workflow.

Provider ingestion remains the sole owner of source descriptions. The browser never supplies or derives a provider description or category during sync.

## Database migration

A forward migration is required because hiding the browser action would otherwise leave two protected mapping RPCs and direct Admin table writes available. The migration must:

- revoke authenticated execution of `apply_stripe_product_mapping(text, text, text, text, text, text)` and `apply_b2c_product_mapping(text, text, text, text, text, text, text)`;
- revoke authenticated `insert` and `update` on `product_mappings`, and remove that table's Admin insert/update policies while preserving approved read access and all retained rows;
- replace `include_b2c_payment_with_finance_exception(uuid, text, boolean, boolean)` so `unmapped` is no longer rejected, without weakening its Admin check, succeeded-payment requirement, provider-ID confirmation, duplicate confirmation, effective USD amount/date requirements, audit insert, or other blocking-flag checks; and
- leave the historical `review_flag_type` enum value, mapping functions, products, mappings, corrections, and review flags intact for audit compatibility.

Never edit an applied migration and never delete or mass-rewrite historical rows. The user applies this forward migration manually through Supabase SQL Editor after the code is merged.

## Error and security behavior

Authorization remains unchanged: provider ingestion stays server-side, all manual corrections and Finance exceptions remain Admin-only and audited, and Viewers remain read-only. Retiring mapping must not create a provider write path or expose raw provider payloads.

Missing descriptions remain unavailable rather than being replaced with a guessed category. Failures in unrelated provider validation, persistence, duplicate construction, or FX handling continue to fail closed under their existing rules.

## Test strategy

Implementation follows TDD and adds regressions proving:

1. A succeeded USD Stripe or Tap payment with `category_code = 'unmapped'` and a historical `unmapped_product` flag is reportable when every other rule passes.
2. Missing email, failed/pending status, missing FX, possible duplicates, duplicate exclusions, and other blocking review items still exclude the payment.
3. Provider ingestion no longer reads `product_mappings` or opens `unmapped_product`, while re-delivery preserves an existing mapped classification.
4. Source descriptions remain visible and missing descriptions render as unavailable.
5. The Work queue, Ledger issue filter, shared drawer, and generic Review Queue expose no live mapping action or unmapped-product task.
6. Finance exceptions retain all non-category confirmations and audit requirements.
7. pgTAP proves an Admin can no longer invoke either mapping RPC or directly write `product_mappings`, while retained mappings remain readable.
8. pgTAP proves an otherwise-eligible `unmapped` provider payment can use the missing-email Finance exception and that every other exception guard still fails closed.
9. Structural tests prove the mapping API has no caller and the retired workflow has one clear ownership boundary.

Run focused Vitest suites first, then a clean Supabase reset, the full pgTAP suite, full Vitest, TypeScript, lint, and diff checks.

## Documentation updates

Update `BUSINESS_RULES.md`, `ARCHITECTURE.md`, `DATABASE_RULES.md`, `INTEGRATIONS.md`, `STRIPE_SETUP.md`, `DATABASE_SCHEMA.md`, and the progress/amendment sections of the two completed B2C plans. The old plans remain truthful historical records; an amendment must explicitly say that this later approved rule supersedes their mandatory mapping gate.

## Out of scope

- Deleting historical mapping, correction, flag, or audit records.
- Inferring standardized categories from free-text provider descriptions.
- Changing manual bank-transfer or Finance Tracker category requirements.
- Weakening provider-ID or 48-hour content duplicate protection.
- Changing Stripe or Tap data.
