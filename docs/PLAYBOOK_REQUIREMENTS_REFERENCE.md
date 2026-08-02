# PLAYBOOK Sales & Reporting Dashboard — Requirements Brief

**Purpose:** What the business needs this dashboard to do, the rules it must never break, and the order to fix things in.

**For:** Mohamed  
**From:** Nada  
**Date:** 29 July 2026  
**Status:** Active build

---

## 01 Purpose

One place where management can see the true state of sales and pipeline without asking anyone for a number.

Today that picture is spread across Stripe, HubSpot, and spreadsheets. Every board update, investor conversation, and monthly review costs someone a day of reconciliation. This dashboard exists to end that.

It must give a trustworthy answer to four questions at any moment:

1. How much did we sell this month?
2. Are we ahead or behind target?
3. What is in the pipeline?
4. What needs attention today?

The bar is trust. A dashboard that is 90% right is worse than no dashboard, because people act on it.

**Correctness comes before features, and features come before polish.**

---

## 02 Who Uses It and What They Need

| Person | Role | What they need |
|---|---|---|
| Wafa | CEO | A 60-second read. Sales vs target, what is at risk. No digging. |
| Nada, Shreya | Management | Pipeline health, deal movement, conversion trends. |
| Fatema H & Walaa | Operations | Enter bank transfers, correct records, review flagged records. |
| Fatema H | Summit | Ticket, sponsor, and booth tracking against target. |

Different people need different depths. That is why the dashboard is structured as three views rather than one long page.

---

## 03 The Three Views

### View 1 — Executive

**The 60-second read.**

A single screen, no tabs, no scrolling for the essentials. If someone has one minute before a meeting, this is what they open.

Must include:

- Sales this month, against target, with a clear ahead/behind indicator
- Six-month sales trend, split B2C / B2B / other
- Year-to-date progress against the annual targets
- A short list — maximum five — of risks and opportunities

### View 2 — Operations

Two tabs: **B2C** and **B2B**.

#### B2C

- Members today and month-to-date
- Acquisition sources
- Processor split
- Refunds
- Subscription health

#### B2B

- Open pipeline by stage
- Bookings this quarter
- Win rate
- Deal velocity
- Stuck deals
- Upcoming renewals
- Top open deals

### View 3 — Reports

Generate, download, archive.

Must include:

- Automated monthly, quarterly, and annual reports
- Ad-hoc reports for any date range
- Branded PDF plus a CSV bundle of the underlying data
- Email delivery to management
- A searchable archive of everything generated

---

## 04 Business Rules That Must Never Break

These are decisions already made. They are not open for reinterpretation during the build.

If the dashboard disagrees with these rules, the dashboard is wrong.

### All Stripe sales are B2C. Always.

Stripe handles individual memberships only.

No B2B deal ever arrives through Stripe.

This must be enforced when data enters the system, not inferred from the product later.

### All B2B pipeline and bookings come from HubSpot or are manually inserted by Finance. Always.

HubSpot is the source for:

- Corporate deals
- Pipeline stages
- Bookings

B2C and B2B must be counted, displayed, and reported separately.

They must never be merged into one number without a clear label.

### Bookings and recognised sales are different numbers.

A signed B2B deal is a booking.

The booking date is the HubSpot close date.

Bookings and recognised sales must be:

- Tracked separately
- Clearly labelled
- Never added together

### HubSpot fallback

If HubSpot becomes too complicated, Finance may enter the B2B data manually.

**Owner:** Fatema H

### Every record passes two duplicate checks.

#### Check 1 — Processor transaction ID

Check whether the provider transaction ID already exists.

#### Check 2 — Content fingerprint

Create and compare a fingerprint using:

- Email
- Amount
- Category
- Date

Check that fingerprint against anything recorded during the previous 48 hours.

Both checks must pass before a record is counted.

This prevents a webhook and a reconciliation sweep from recording the same item twice.

### Refunds are recorded, never deleted.

A refund must be recorded as its own entry linked to the original payment.

The original payment stays in the ledger unchanged.

Financial records are append-only.

### B2B and B2C are reported in USD only.

Deals in other currencies must be converted when recorded.

The system must also keep:

- Original currency
- Conversion rate
- Converted USD amount

This information must remain available for audit.

### Empty is not zero.

If data has not been backfilled, say so.

Never show zero for a period that has not been loaded.

Use labels such as:

- Data not loaded
- Not yet backfilled
- Historical data unavailable

Only show zero when the system knows the actual value is zero.

---

## 05 Data Sources and Owners

| Source | Provides | Method | Owner |
|---|---|---|---|
| Stripe | B2C payments, renewals, refunds | Webhook + daily reconciliation sweep | Fatema H / Walaa |
| Tap | B2C payments (regional) | Webhook + daily sweep | Fatema H / Walaa |
| HubSpot | B2B deals, stages, bookings, renewals | Webhook + daily sync | Shreya |
| Bank transfers | B2C payments paid by IBAN | Manual entry in admin | Fatema H |
| Summit tracker | Tickets, sponsors, booths | Manual entry or Slack update | Fatema H |

### Important

Webhooks can be missed because networks fail and servers restart.

A daily reconciliation sweep that re-pulls the previous 48 hours from each provider is mandatory.

The duplicate checks in Section 04 make that sweep safe to run.

---

## 06 Reporting Requirements

Reports are the main output of this system. Everything else supports them.

### Automatic reports

#### Monthly

- Runs on the first of each month
- Covers the month that just ended

#### Quarterly

Runs on the first of:

- January
- April
- July
- October

#### Annual

- Runs on the first of January
- Covers the previous year

### Every report contains

- A branded PDF with:
  - Summary figures
  - Sales trend
  - Pipeline
- A CSV bundle of the underlying rows so every figure can be traced to its source
- Email delivery to management
- An archived copy that remains downloadable later

### Do not automate a broken report

Scheduled delivery must remain disabled until report generation is proven reliable.

Sending incorrect numbers automatically is worse than sending nothing.

### On-demand reports

Any user should be able to:

- Select a date range
- Generate the same report immediately
- Download it
- Email it

### Report recipient

**Fatema H**

---

## 07 Admin Controls

Not every number arrives through an integration.

The team must be able to enter and correct figures directly, safely, and with a full record of who changed what.

**Primary users:** Fatema H and Walaa

### Required controls

#### Bank transfer entry

Record a B2C payment received by IBAN.

It must pass the same duplicate checks as an automatic record.

#### Correct a record

Allow correction of:

- Amount
- Date
- Category

#### Product mapping

Map a Stripe or Tap product to:

- Internal category
- Membership tier

#### Targets

Allow annual and quarterly targets to be changed without a code change.

#### Summit tracker

Allow updates for:

- Tickets
- Sponsors
- Booths

### Audit requirement

Every manual change must record:

- Person who made the change
- Timestamp
- Previous value
- New value

The system must always be able to answer:

> Who changed this and when?

This is mandatory.

---

## 08 Flags and Review Queue

The team needs one place to see records that need a human decision before month-end.

| Flag | Meaning | Action needed |
|---|---|---|
| Refunded | Money returned to the customer | Confirm the reason is recorded |
| Failed | Payment attempt did not go through | Follow up with the member |
| Possible duplicate | Matched an existing record closely | Confirm or dismiss |
| Unmapped product | Product has no category assigned | Map it so it is categorised |
| Needs follow-up | Manually marked by the team | Follow the note |

Each flag must be clearable with a note.

Cleared items must remain visible in history.

They must not be deleted.

---

## 09 Alerts

Alerts are posted to Slack so nobody has to remember to check the dashboard.

### Daily alert

- New members yesterday
- Sales yesterday
- Performance against target

### Weekly alert

- Pipeline movement
- Deals won
- Deals lost
- What is stuck

### B2C slowdown alert

Trigger when B2C performance is below half the daily target for three consecutive days.

### Large deal lost alert

Trigger when a high-value B2B deal is marked lost.

### Pipeline drop alert

Trigger when total open pipeline falls by more than 20% week on week.

---

## 10 Current State of the Old System

This section describes the inherited implementation.

| Area | Status | Detail |
|---|---|---|
| Stripe ingestion | Works | Records captured, duplicate checks wired in |
| HubSpot sync | Works | Connected; field mapping must be verified against real data |
| PDF generation | Works | Confirmed producing a valid report |
| PDF download | Broken | Downloads arrive empty; the file is valid but delivery is not |
| Report reliability | Partial | Half of past runs failed; a fix exists but is untested |
| Stuck jobs | Broken | Failed reports can remain pending forever with no timeout or retry |
| Admin controls | Partial | Bank transfer entry exists; corrections and mapping do not |
| Flags | Partial | Data is captured but nothing surfaces it to the team |
| Scheduled reports | Broken | Several scheduled jobs call functions that do not exist |
| Access control | Broken | Login was disabled for testing and must be restored |

### PDF issue

The empty PDF is not a report-generation problem.

A valid report exists on disk.

The likely issue is either:

- The download link cannot carry the login session
- File paths are stored relative to wherever the server started

Confirm the real cause before changing the generator.

### Data durability

The old system uses SQLite on a host with a temporary filesystem.

Without permanent storage, records may be lost during a restart or redeployment.

This must be resolved before more real data accumulates.

---

## 11 What to Fix, in What Order

| Priority | Item | Reason |
|---|---|---|
| P0 | Restore login and access control | Data is currently reachable without signing in |
| P0 | Secure the database against data loss | Everything else is pointless if records disappear |
| P1 | Fix PDF download | Most visible failure; the underlying report already works |
| P1 | Re-run failed reports | Validates the full reporting path |
| P2 | Enforce Stripe = B2C and HubSpot = B2B at ingestion | Prevents silent miscategorisation |
| P2 | Verify duplicate detection against real data | Double-counting is the worst possible error |
| P2 | Build flags and review queue | Surfaces information the system already captures |
| P2 | Build admin corrections and product mapping | Requires categorisation to be settled first |
| P2 | Fix and enable scheduled reports and alerts | Only after reports are proven reliable |

The sequence matters.

Do not automate reports before verifying the numbers.

---

## 12 Definition of Done

The system is working when:

- Every figure on screen can be traced to:
  - Stripe
  - HubSpot
  - A named person's manual entry
- B2C and B2B are never accidentally combined
- Records are never double-counted
- A month-end report:
  - Generates
  - Downloads
  - Emails automatically
- Management can close the month from the dashboard instead of rebuilding figures in a spreadsheet
- Nada can answer “How are we doing?” in under one minute without asking anyone
- The team learns about problems through alerts instead of discovering them weeks later

---

## 13 Open Decisions

### 1. Repair or rebuild?

Choose whether it is faster to:

- Repair the existing system
- Rebuild on a familiar stack

Provide a rough timeline for both.

### 2. Scheduled report execution

If rebuilding, define how scheduled reports will run when generation takes longer than a typical serverless request.

This must be decided before development begins.

### 3. Database location

Choose where the database should live so an application deployment can never destroy financial records.

### 4. Individual logins or shared account?

Six people use the system.

Manual edits must be attributable.

The preferred option is individual logins, but cost and setup must be explained.

### 5. First working slice

Estimate how long it will take to have:

- One real Stripe record
- Saved in the database
- Classified correctly
- Displayed correctly on screen

---

## Rebuild Requirement

If the system is rebuilt, all rules in Section 04 must carry over exactly as written.

They were developed over months.

Do not reinterpret or re-derive them.

If the new system uses different rules, the new and old dashboards may produce different numbers with no reliable way to determine which one is correct.

---

## Implementation Reference Rule

This document is the source of truth for the rebuild.

When code, old implementation behavior, or assumptions conflict with this document, follow this document and flag the conflict for review.

Do not modify, weaken, or reinterpret the business rules without explicit approval.
