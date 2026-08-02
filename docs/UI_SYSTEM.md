# UI System

## Purpose

The Phase 1 UI establishes a calm, premium internal financial operating system. It is a frontend-only framework using isolated, typed mock data. It must never be mistaken for live financial reporting or access control.

## Design principles

- Scan first: important metrics and their scope are visible before deep detail.
- Financial clarity: pipeline, bookings, cash, and recognised sales use separate labels and are never combined.
- Quiet confidence: light type weight, restrained colour, square-to-gently-rounded surfaces, subtle borders, and minimal shadows.
- Traceability: tables reserve space for flags, source, statuses, and future history.

## Typography and spacing

The interface uses system sans-serif typography with medium weights reserved for labels and key values. Layout spacing follows a compact 4px rhythm: 16px gaps for related controls, 20px card padding, and 28px page spacing. Cards use a thin neutral border and a single subtle shadow.

## Tables and charts

Tables preserve complete financial fields and use controlled horizontal scrolling below desktop widths. Statuses always include text, not colour alone. Charts use muted green and warm neutral series colours, explicit legends, and labelled financial scope. Charts never imply that B2B bookings are recognised revenue.

## States

Shared state components cover loading, empty, error, permission-restricted, and not-backfilled states. A not-backfilled value must say `Data not loaded`, `Historical data not available`, or `Not yet backfilled`; it must not display zero.

## Responsive behaviour

Desktop is primary, with a persistent sidebar. Tablet and mobile use an accessible slide-over navigation and wrapping metric grids. Tables retain their columns and scroll horizontally rather than hiding critical financial data.

## Accessibility

All controls have visible keyboard focus. Tables include captions and semantic headers; dialogs use dialog semantics and labelled close controls. Text and status labels convey information independently of colour. Form controls have associated labels.

## Animation

Framer Motion is limited to a short entry transition on metric cards. There are no decorative loops, large movement effects, or animation-dependent interactions.

## Reusable components

`AppShell`, `MetricCard`, `ProgressMetric`, `StatusBadge`, `SectionCard`, `DataTable`, `FilterBar`, `DateRangeSelector`, state components, chart components, `AuditHistory`, `DetailDrawer`, `ConfirmationDialog`, and `FormField` are presentation primitives. Page components compose them with feature mock data; financial calculations and provider behaviour belong outside this UI layer.
