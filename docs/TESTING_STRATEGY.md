# Testing Strategy

Financial correctness must be testable.

## Required test categories

### Unit tests

Test:

- financial calculations
- duplicate detection
- refund behavior
- classification rules
- currency/conversion logic where implemented
- status transitions

### Integration tests

Test:

- Stripe webhook processing
- Tap webhook processing
- HubSpot sync/webhook mapping
- database writes
- authorization boundaries
- report data preparation

Use provider sample/test payloads where possible.

### End-to-end tests

Cover critical workflows such as:

- approved user login
- B2C transaction appearing correctly
- manual bank-transfer entry
- record correction with audit history
- review queue resolution
- report generation/download

## Regression tests

When fixing a critical financial bug, add a test that would have caught that bug whenever practical.

## Known-value validation

Critical financial totals must be tested using small datasets with manually known expected results.

Examples:

- sale + full refund = net zero
- sale + partial refund = original minus refund
- duplicate event does not increase totals
- booking is not added to recognised revenue
- missing period is not represented as zero

## Completion rule

A feature is not complete until its relevant tests pass.
