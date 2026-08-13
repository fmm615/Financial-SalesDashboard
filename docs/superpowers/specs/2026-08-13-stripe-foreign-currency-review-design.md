# Stripe foreign-currency source review design

## Goal

Retain every valid Stripe payment and refund in PLAYBOOK's B2C source ledger,
including transactions whose source currency is not USD. Give approved users a
simple way to show those records, while preventing them from affecting USD
financial totals until Finance approves a specific foreign-exchange rule and
source.

## Context

The existing Stripe historical import successfully reconciles the USD entries in
the supplied Stripe export. It currently rejects valid non-USD entries because
PLAYBOOK has no approved FX source or conversion rule. This leaves the source
history incomplete even though the provider supplied a real transaction.

The approved Stripe export contains GBP and BHD source transactions as well as
USD transactions. A source amount in GBP or BHD is not a USD amount and must
not be presented as one.

## Decisions

### 1. Retain non-USD source records

The Stripe normalisation and sync boundary will stop treating a valid non-USD
currency as an integration error by itself. It will retain the provider ID,
original amount, original currency, business date, payment/refund status, and
safe source context in the existing local source-ledger model.

For a non-USD record:

- `original_amount` and `original_currency` remain the exact provider values.
- `amount_usd` and `exchange_rate_to_usd` remain unknown (`NULL`), never zero
  and never a guessed conversion.
- A clear local `Needs FX review` state is derived from the non-USD source
  currency. Existing flags such as failed, refunded, duplicate, and missing
  customer details remain independent and visible.
- A valid non-USD record is not added to Integration Errors merely for using a
  different currency. True provider-fetch, validation, or persistence failures
  continue to be recorded safely as Integration Errors.

### 2. Hard reporting and Finance boundary

The shared B2C reportability calculation, database reportable views/functions,
and Finance-exception path will require a source currency of USD and a known
USD amount. A non-USD transaction cannot become reportable merely because an
Admin adds a local name, category, amount, or reason.

This preserves the existing rule that B2C reporting is in USD and avoids
silently turning original-currency source evidence into revenue. A future
Finance-approved FX policy must specify the rate source, effective date,
rounding, approval owner, and audit treatment before this boundary can change.

### 3. Simple B2C Operations review control

B2C Operations will show a compact, count-based control such as **Show
foreign-currency review (34)** beside the existing ledger controls. Selecting
it filters the ledger to source records whose original currency is not USD;
selecting it again or clearing filters restores the regular view.

Those rows will show the original amount and currency plainly. The UI will not
display `$0.00` as a substitute for an unknown USD value. The control is
visible to approved Viewers for traceability; only Admins retain access to
local review/correction actions.

### 4. Provider and audit safety

This work creates no Stripe mutation capability. The Stripe client remains
restricted to read-only provider requests. Local Admin actions continue to be
request-scoped, RLS-protected, append-only/audited, and unable to alter Stripe
source records.

## Data and migration approach

A migration will make the local USD amount and USD exchange-rate fields nullable
where required for legitimate non-USD source evidence. It will update any
database-side reportability/Finance-exception function so that the same
currency gate is enforced below the UI.

Existing USD rows remain unchanged. Existing non-USD records, if any were
previously rejected, are retrieved by a safe re-run of the read-only historical
import and are deduplicated by their provider transaction IDs.

## Verification

Automated coverage will prove that:

1. a USD Stripe payment keeps its existing normalisation and reportability;
2. GBP/BHD payments and refunds are retained with original-currency values and
   no invented USD amount or FX rate;
3. non-USD items are excluded from all reportability and Finance-exception
   paths;
4. a true Stripe failure remains an Integration Error; and
5. the B2C ledger control filters foreign-currency records without changing
   provider data or financial totals.

Relevant integration, architecture, and testing documentation will be updated
with this boundary.
