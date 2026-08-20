# PLAYBOOK UI System

## Brand source and intent

The UI is derived from the Meet Layla PLAYBOOK experience: a dark ink foundation, vivid violet accent, lime calls to action, Inter typography, soft white surfaces, pill-shaped utility controls, and concise confident hierarchy. The dashboard adapts this family for financial work: it avoids marketing gradients and decorative imagery in operational views, while retaining the warmth, clarity, and premium contrast of the source experience.

## Tokens

All custom visual values are defined in `src/app/globals.css` and exposed through semantic Tailwind tokens. Components must use those tokens rather than new hexadecimal values.

| Token group | Usage |
| --- | --- |
| `brand-primary` | PLAYBOOK ink/navy, high-emphasis metric cards, profile identity |
| `brand-accent` | Violet navigation state, links, progress, B2C chart series, focus association |
| `brand-lime` | Primary CTA and selected utility emphasis |
| `canvas`, `surface`, `surface-muted`, `surface-accent` | Warm page and panel surfaces |
| `text-primary`, `text-secondary`, `text-muted`, `border` | Reading hierarchy and lightweight dividers |
| `success`, `warning`, `danger` | Semantic financial/review states only |
| `chart-*` | Stable B2C, B2B recognised, bookings, pipeline, and supporting chart colours |

The actual source values include ink `#0d0b24`, violet `#7b2ff7`, lime `#c7ff00`, and the warm surface family. Radius and shadow tokens are centralised alongside these colours.

## Typography and spacing

Inter is the interface typeface, with a system fallback. Headings use a restrained semibold weight and tight letter spacing; body and metadata use normal/medium weights with generous line height. Financial values use tabular numerals. The layout follows a 4px rhythm with 16px control gaps, 20px panel padding, and 28–32px page spacing. The Playfair accent from Meet Layla is intentionally not used in financial figures or tables, preserving quick comparison and reporting clarity.

## Surfaces, cards, tables, and charts

Cards use soft white surfaces, a fine border, 14px radius, and low-elevation shadows. Important executive position cards may use ink with lime supporting detail. Cards never use decorative gradients.

Tables use a quiet tinted header, roomy rows, subtle dividers, right-scroll containment on narrow screens, and a low-key hover state. Financial values should retain tabular alignment and row actions must not visually dominate.

Chart mapping is fixed: B2C recognised sales is violet; B2B recognised sales is blue-teal; B2B bookings are warm gold; pipeline is blue; other/supporting series are muted slate. Tooltips, legends, and labels use the same token system. Bookings are always separately labelled from recognised sales.

## Badges and states

Badges pair readable text with semantic colour and, where useful, a status icon. Completed and ahead use success; pending and processing use violet; warnings, possible duplicates, and unmapped products use warning; failures and behind-target use danger; historical/unavailable values use the muted surface. No state depends on colour alone.

## Motion and micro-interactions

`src/lib/motion.ts` provides reusable `pageTransition`, `sectionReveal`, `cardReveal`, `staggerContainer`, `drawerTransition`, `dialogTransition`, and `fadeTransition` variants. Motion is limited to short opacity, small vertical movement, drawer/dialog orientation, and press feedback. Static financial cards do not lift on hover. Buttons, filters, navigation, drawers, dialogs, and content reveals use subtle feedback only.

`prefers-reduced-motion` is respected in global CSS and motion components, which disable reveal variants when the user requests reduced motion.

## Responsive and accessibility rules

Desktop retains the persistent sidebar. Tablet and mobile use a branded animated navigation sheet; metrics stack logically and charts shrink without losing labels. Tables use controlled horizontal scrolling rather than hiding financial fields.

Visible focus rings use the violet focus token. Controls have labels, tables have captions and semantic headers, dialogs/drawers have appropriate roles and accessible close controls, and status information is text-based as well as colour-coded. The design is light mode only.

## B2C workspace pattern

`/operations/b2c` is one page with `Work queue`, `Ledger`, and `Sources` tabs stored in the URL query string, not three separate pages. Each live B2C action renders in exactly one place: a Ledger or Work queue row opens the shared record drawer through one `Review`/next-action button rather than several row-level triggers, and Sources is the sole owner of provider sync, backfill, evidence upload, and Payment Tracker import. Dense filter sets follow a disclosure pattern -- a few primary filters stay visible, with the rest collapsed under `More filters` and a count badge -- rather than an always-expanded filter wall.

## Component use

`AppShell`, `MetricCard`, `ProgressMetric`, `StatusBadge`, `SectionCard`, `DataTable`, `FilterBar`, `DateRangeSelector`, chart components, state components, `AuditHistory`, `DetailDrawer`, `ConfirmationDialog`, and `FormField` are the shared presentation system. They do not contain financial calculations, provider logic, or authorization decisions.
