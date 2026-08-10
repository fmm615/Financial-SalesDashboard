# Report Foundation Design

## Goal

Build the reporting platform before B2C and B2B financial data is approved. When Finance approves source data, the platform should need only report-data adapters and calculation inputs—not a redesign of jobs, archives, templates, or delivery controls.

## Scope

The foundation includes:

- one typed report-data contract shared by PDF, CSV, dashboard, and future email delivery;
- explicit data coverage per reporting area: `available`, `partial`, `not_loaded`, or `unavailable`;
- a readiness gate that prevents a report from being labelled financial when required coverage is incomplete;
- a reusable branded report template with fixed sections and clear draft/disclosure states;
- durable job processing, retry, stale-job failure handling, private archive, search, and secure downloads;
- a disabled delivery interface that can later use Resend without changing report-generation logic.

The foundation does not include:

- B2C or B2B totals, source rows, targets, pipeline values, or derived metrics;
- automatic monthly, quarterly, or annual job creation;
- real email sending, recipient configuration, or Resend credentials.

## Report-data contract

Each report generator receives a `ReportDataSnapshot`, never raw provider rows. The snapshot contains the selected period, generated-at time, coverage by area, report sections, and traceability metadata.

Each financial section is either:

- `available` with approved values and source-row references;
- `partial`, `not_loaded`, or `unavailable` with a safe explanation and no invented numeric value.

The readiness gate evaluates the areas required by the selected report type. A report is `financial_ready` only when every required area is `available`; otherwise it is `draft_fixture_only` and carries an explicit disclosure in the PDF, CSV, archive, and any future delivery record.

## Template and artifacts

The report template has a stable layout: title/period, readiness disclosure, executive summary, sales trend, pipeline, coverage, and traceability appendix. Before data is ready, each financial section renders a disclosure instead of a zero or a placeholder metric.

PDF and CSV generation use the same snapshot. The CSV is an auditable bundle of the snapshot sections and source references; it contains no provider data until an approved adapter supplies it. Artifact metadata records the snapshot status and version so a historical download remains explainable.

## Job, archive, and delivery flow

An Admin queues a job. A protected worker processes one bounded pending job, records `processing`, writes artifacts to private Supabase Storage, creates archive metadata, and marks the job `completed` or `failed`. A worker recovers jobs that remain in `processing` for more than 15 minutes by marking them failed; an Admin can requeue them after review.

Approved users can list and download archived files. Only Admins can queue or requeue jobs. A future delivery adapter receives only a completed, `financial_ready` report; the initial adapter is disabled and creates no email request.

## Testing

Unit tests cover coverage-state mapping, readiness gating, draft disclosures, CSV/PDF consistency, and artifact metadata. Integration tests cover Admin-only queue/retry, worker state transitions, stale-job recovery, private downloads, and the rule that disabled delivery cannot send email.

## Delivery order

1. Report-data contract and readiness gate.
2. Template model and draft disclosures.
3. Archive/job status and artifact metadata integration.
4. Disabled delivery adapter interface.
5. Approved B2C/B2B data adapters and shared calculations.
6. Finance validation, then Resend delivery and scheduled report creation.
