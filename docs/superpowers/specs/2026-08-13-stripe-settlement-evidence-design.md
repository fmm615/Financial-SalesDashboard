# Stripe Settlement Evidence Design

## Goal

Show the Stripe payment evidence requested from the Stripe Charges export in B2C Operations, without changing Stripe or allowing settlement/conversion evidence to alter Finance totals.

## Scope

For each Stripe charge, PLAYBOOK will retrieve and retain, when Stripe provides it:

- original charge amount and currency;
- gross settlement amount, Stripe fee, fee tax, and net payout;
- settlement/converted currency and Stripe-provided exchange rate;
- refund amount and refund settlement evidence when available;
- description and seller message;
- cardholder name and masked card context.

The operational ledger will show this evidence for approved Admin and Viewer users. The expanded details presentation will make the provenance explicit: original charge, Stripe settlement, and local PLAYBOOK reporting values are distinct concepts.

## Financial Rules

- Gross customer payment, Stripe fee, fee tax, net payout, refund, and settlement amount are separate fields.
- Stripe settlement conversion is evidence only. It does not create a USD conversion rate, change the original payment, alter local B2C reporting values, or change Finance totals.
- The current USD-only reporting rule remains unchanged. No non-USD charge becomes reportable through this feature.
- Refunds remain separate records linked to the original payment.
- Missing Stripe values remain null/labelled unavailable; PLAYBOOK never guesses them.

## Read-only Provider Boundary

The Stripe client remains GET-only. It can read the Charge, its related Checkout Session, Invoice, Payment Method, Customer, Balance Transaction, and refund information. It has no create, update, refund, delete, or mutation method. PLAYBOOK writes only normalized evidence to Supabase.

## Access

Approved Viewers (Management) may see the requested operational Stripe evidence. Only Admins (Finance) may make local corrections, create mappings, resolve reviews, or approve a Finance exception. Raw provider payloads remain unavailable to the browser.

## Error Handling

Optional enrichment failure does not discard the valid charge. The payment stays visible, retained values remain intact, and a safe integration error is recorded for retry. A missing balance transaction, cardholder name, seller message, or conversion value is displayed as unavailable.

## Tests

Tests cover conversion/settlement normalization, fee-tax calculation, safe card display, optional-field absence, no change to reportability, and a GET-only Stripe client.
