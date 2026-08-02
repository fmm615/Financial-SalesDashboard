# Security Rules

Security is a release requirement, not a later enhancement.

## Authentication

Use Supabase Auth.

The intended login method is Google Sign-In for approved PLAYBOOK users.

Only approved user accounts may access the application.

## Authorization

Authorization must be enforced on the server and, where appropriate, using PostgreSQL Row Level Security.

Never rely only on:

- hidden UI elements
- client-side route guards
- disabled buttons

## Roles

Use role-based access where needed, for example:

- admin
- finance/operations
- management
- sales
- viewer

Permissions should follow least privilege.

## Secrets

Never expose, commit or log:

- Supabase service-role key
- Stripe secret keys
- webhook secrets
- HubSpot private tokens
- provider credentials
- email credentials

Only intentionally public browser-safe values may use `NEXT_PUBLIC_`.

## Input validation

Treat all external input as untrusted, including:

- form data
- query parameters
- API bodies
- webhook payloads
- uploaded/imported files
- third-party API responses

Validate at system boundaries.

## Webhooks

- Verify signatures for every provider that supports them.
- Prevent duplicate processing.
- Keep provider event IDs.
- Design idempotent processing.
- Record failures safely for review.

## Data exposure

Do not expose financial information to unauthorized users.

Do not include sensitive financial or provider payloads in logs unless strictly necessary.

## Admin actions

Every important manual financial change must be attributable to the logged-in user and recorded in the audit log.
