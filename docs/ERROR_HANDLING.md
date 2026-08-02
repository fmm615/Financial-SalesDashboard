# Error Handling

Important failures must never disappear silently.

## General rules

- Return clear, safe errors to users.
- Record technical details server-side where appropriate.
- Never expose secrets in error messages.
- Never silently convert a failed operation into success.

## Integration failures

For Stripe, Tap, HubSpot and other providers:

- record processing failures
- keep the provider/event reference
- store a safe error summary
- allow review/retry where appropriate

## Background jobs

Long-running operations should use explicit statuses:

- pending
- processing
- completed
- failed

A failed job must not remain `pending` forever.

Store:

- started time
- completed/failed time
- retry count where relevant
- safe error message

## Reports

If report generation fails:

- do not email the report
- mark the report job failed
- keep enough information for review
- allow regeneration/retry

## Financial safety

When uncertain whether a financial operation succeeded, do not count it silently.

Prefer a reviewable failure state over an incorrect financial total.
