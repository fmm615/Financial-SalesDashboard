# B2C Payment Duplicate Groups Design

**Date:** 2026-08-23

**Status:** Approved

**Scope:** Replace independent B2C `possible_duplicate` flags with an auditable group decision workflow while keeping Finance-workbook exact duplicates separate.

## Context

Every reportable B2C payment must pass both the provider-transaction-ID check and the approved content check: email, amount, category, and business date against the preceding 48 hours. The current provider, manual-transfer, and local-correction paths correctly retain possible matches and open blocking `possible_duplicate` review flags. They do not retain which payments were matched together.

The generic review resolution function deliberately rejects these flags. That protection is correct: closing one independent flag could make a duplicate payment reportable without recording which candidate Finance reviewed. The current drawer nevertheless routes every `possible_duplicate` reason to the Finance-workbook exact-pair component. That component operates on `b2c_reconciliation_groups`, not payment flags, so it cannot resolve Stripe, Tap, or manual-bank-transfer duplicate candidates.

## Decision

Introduce a dedicated B2C payment-duplicate group model. A group retains the payments that satisfied the approved content rule at detection time. An Admin resolves the group atomically by choosing either:

- `keep_all`: every member represents a real separate payment; or
- `keep_one`: one selected payment remains eligible and every other member is explicitly excluded.

All source payments remain immutable. A decision changes reporting eligibility only through append-only, audited duplicate-decision records and review-flag resolutions.

Finance Payment Tracker exact pairs remain in the existing Finance reconciliation model. They receive a distinct `finance_exact_duplicate` Work item and continue through the existing exact-Finance-group decision route. Payment duplicate groups never contain staging rows, and Finance reconciliation groups never contain provider/manual payment duplicate decisions.

## Alternatives considered

### Resolve each flag independently

This is smaller, but it loses the relationship between candidates. Two independent “keep” decisions could count the same sale twice, and an exclusion would not identify the compared candidate. Rejected.

### Recompute the counterpart only when the Admin clicks

This avoids new group tables but makes the audit outcome depend on mutable current values. Corrections or later imports could change the candidate set between detection and decision. Rejected.

### Persist groups at detection time

This preserves the evidence boundary, supports one atomic decision, and matches the repository's existing B2B duplicate-group pattern without mixing B2B and B2C data. Selected.

## Data model

### `b2c_payment_duplicate_groups`

The group stores:

- an immutable UUID;
- the canonical content fingerprint used when the candidate was detected;
- `open` or `resolved` status;
- nullable `keep_all` or `keep_one` decision while open, required when resolved;
- the selected canonical payment only for `keep_one`;
- the required resolution reason, actor, and timestamp; and
- creation timestamp and safe detection reason.

The database enforces the full state transition with check constraints. Only one open group may use a given fingerprint. A resolved group is never reopened or overwritten. A later payment with the same content creates a new review case when it introduces facts not covered by the completed decision.

### `b2c_payment_duplicate_group_members`

Each member stores:

- group ID and payment ID;
- `pending`, `include`, or `exclude` decision;
- creation timestamp.

The composite group/payment key is unique. A payment may have historical membership in more than one resolved case, but it may not be placed in multiple open cases. If historical decisions overlap, `exclude` wins for reporting eligibility; an open case always blocks until resolved.

Both tables use Admin-only reads, no direct authenticated writes, audit triggers, and protected constructor/resolver functions. Viewers receive no access to candidate membership.

## Candidate construction

Duplicate detection moves behind one protected database constructor so webhook processing, provider reconciliation, manual bank transfers, and verified local corrections use the same rule.

For one succeeded target payment, the constructor reads its effective verified values, computes the approved canonical fingerprint, and finds succeeded payments with the same effective email, USD amount, category, and business date inside the approved 48-hour boundary. Provider transaction IDs remain the stronger exact key and never create a content group for the same provider transaction.

When at least two valid payments match, the constructor:

1. locks the candidate payments and any open matching group;
2. creates or extends one open group idempotently;
3. inserts the retained member set;
4. opens one blocking `possible_duplicate` review flag for every member that does not already have one; and
5. records the safe detection reason.

Repeated provider delivery or reconciliation is a no-op for the same open candidate set. A completed group is never silently reopened. If a genuinely new member appears later, the constructor creates a new case using the still-eligible prior members and the new payment; previously excluded members do not become eligible again.

The current TypeScript fingerprint implementation and SQL constructor must share a parity corpus or the application must stop constructing the fingerprint independently. The preferred implementation makes SQL authoritative for group construction and leaves TypeScript responsible only for validated source normalization.

## Historical migration

The forward migration examines existing open B2C `possible_duplicate` flags and invokes the same constructor for each flagged payment.

- A group is backfilled only when current retained/effective values prove at least two members under the approved business rule.
- All proven members receive group membership and an open flag, including a counterpart that an older manual-transfer path did not flag.
- Ambiguous candidate sets become one group containing every proven member; the migration never chooses a canonical payment.
- A flag with no currently provable counterpart remains open and ungrouped. It is not silently dismissed.

The dedicated API exposes ungrouped legacy flags as “candidate unavailable.” A separate protected stale-flag action may dismiss one only after the database revalidates that no current content candidate exists and the Admin records a reason. It cannot be used while a matching payment exists.

## Resolution transaction

The resolver accepts group ID, `keep_all` or `keep_one`, an optional canonical payment ID, and a meaningful reason of 3–1000 characters.

Inside one transaction it:

1. verifies the authenticated actor is an Admin;
2. locks the open group and all members;
3. rejects stale, repeated, or malformed decisions;
4. rechecks that every member is still a retained payment and that the selected canonical payment belongs to the group;
5. writes `include`/`exclude` member outcomes;
6. resolves the group with actor, reason, and timestamp; and
7. appends review-flag resolutions for members that have no other open duplicate group.

`keep_all` marks every member `include`. `keep_one` marks exactly the selected member `include` and every other member `exclude`. The resolver never deletes or updates a source payment and never calls Stripe or Tap.

Direct group/member updates or deletes are rejected. Repeating the same browser request cannot create a second decision.

## Reporting and decision model

The B2C repository loads two independent duplicate facts for each payment:

- whether it belongs to any open B2C payment-duplicate group; and
- whether any resolved group explicitly excluded it.

An open group produces `possible_duplicate`, `duplicate_pending`, and a blocked reporting decision. A resolved exclusion produces an explicit duplicate exclusion and remains outside every financial total even though its source status is succeeded. A resolved inclusion removes only the duplicate block; every other reporting requirement still applies.

`possible_duplicate` remains exclusively a payment-group reason. Because an unresolved Finance reconciliation group exists before a `b2c_payments` row is created, represent it directly as a `finance_exact_duplicate` Work item rather than injecting that state into a payment decision. Work-item routing maps both workflows to the visible Duplicates queue but gives them distinct targets and actions.

## API and repository boundaries

Thin Admin-only routes provide:

- listing the group associated with a payment or Work item;
- resolving one payment duplicate group through the protected RPC; and
- dismissing only a revalidated ungrouped stale legacy flag.

Repositories map raw rows into UI-safe group/member records. APIs never return provider raw payloads. Viewer requests fail before candidate data is loaded, and all writes use the request-scoped authenticated client so RLS and audit triggers record the individual Admin.

## Drawer workflow

For `possible_duplicate`, the shared drawer displays the group members side by side with source, customer, provider reference, amount, currency, category, and business date. It requires a meaningful reason and offers:

- “Keep all payments”; or
- selection of one member followed by “Keep selected payment only.”

The UI states that excluded members remain in source history and that no provider data is changed. Buttons stay disabled until inputs are valid. On server success, the drawer closes and the Work queue refetches.

For `finance_exact_duplicate`, the drawer renders the existing Finance exact-pair review using the specific reconciliation group. It never loads or renders the payment duplicate component.

Viewers see the evidence and read-only status but no decision controls.

## Error handling and concurrency

- All business validation is repeated in SQL; browser state is advisory.
- Group construction and resolution use row locks and deterministic lock order.
- A second resolver receives a safe already-resolved error and cannot overwrite history.
- Provider/manual writes fail atomically if creating the required blocking group/flags fails.
- API responses contain safe messages and never expose SQL text, raw payloads, or secrets.
- Large candidate reads are paginated or bounded; no unbounded PostgREST `IN` query is allowed.

## Testing

### Database tests

pgTAP verifies Admin-only construction/resolution, Viewer rejection, idempotent detection, keep-all, keep-one, exactly one included canonical member, immutable resolved groups, review-flag closure, overlapping-open-group rejection, exclusion precedence, stale legacy dismissal safeguards, and fail-closed historical backfill.

### Domain and repository tests

Tests verify payment-level and Finance-level blocking reasons never cross, open/excluded group facts affect reportability correctly, and repository mapping does not disclose candidates to Viewers.

### API and UI tests

Tests verify strict request validation, required reasons, group-specific routing, keep-all/keep-one payloads, stale-response handling, post-save queue refresh, read-only Viewer behavior, and that manual/Stripe/Tap payment duplicates never render the Finance workbook component.

### Full verification

Run a clean local Supabase reset, pgTAP, all Vitest suites, TypeScript, lint, and diff checks. The migration must be supplied for manual Supabase SQL Editor application and applied only after its dependencies.

## Rollout

1. Apply the new payment-duplicate-group migration after `20260820110000_b2c_provider_evidence_mismatches.sql`.
2. Confirm the guarded historical backfill created groups only for provable candidates and report the count of ungrouped legacy flags.
3. Deploy the application routes and UI after the schema is present.
4. Monitor unresolved groups and ungrouped legacy flags; do not bulk-dismiss them.

Rollback is forward-only: source payments and decisions are retained. If the UI must be disabled, open groups and flags continue blocking totals safely.
