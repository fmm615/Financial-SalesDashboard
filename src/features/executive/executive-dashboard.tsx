import { SalesTrendChart } from "@/components/charts";
import { AppShell } from "@/components/app-shell";
import { DateRangeSelector, MetricCard, NotBackfilledState, ProgressMetric, SectionCard, StatusBadge } from "@/components/ui";
import { executiveMetrics, risksAndOpportunities, salesTrend } from "@/mocks/executive";

export function ExecutiveDashboard() { return <AppShell title="Executive overview" description="A 60-second operating view. Recognised sales and B2B bookings stay deliberately separate." controls={<DateRangeSelector />}>
  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{executiveMetrics.map((metric, index) => <MetricCard key={metric.label} {...metric} emphasis={index === 0} />)}</div>
  <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,1fr)]">
    <SectionCard title="Recognised sales trend" description="Six-month view by recognised revenue stream. B2B bookings are excluded." action={<span className="rounded-pill bg-surface-accent px-2.5 py-1 text-xs font-medium text-brand-accent">Mar–Aug 2026</span>}><SalesTrendChart data={salesTrend} /></SectionCard>
    <SectionCard title="Year-to-date progress" description="Recognised sales against approved annual targets"><div className="space-y-6"><ProgressMetric label="Total recognised sales" value="$1.02m" target="$1.80m" progress={57} /><ProgressMetric label="B2C recognised sales" value="$561k" target="$900k" progress={62} /><ProgressMetric label="B2B recognised sales" value="$459k" target="$900k" progress={51} /></div></SectionCard>
  </div>
  <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,1fr)]"><SectionCard title="Management attention" description="Prioritised risks and opportunities to review this period"><ul className="divide-y divide-border">{risksAndOpportunities.map((item) => <li key={item.title} className="flex gap-3 py-4 first:pt-0 last:pb-0"><StatusBadge status={item.type} /><div><p className="text-sm font-medium text-text-primary">{item.title}</p><p className="mt-1 text-sm leading-6 text-text-muted">{item.detail}</p></div></li>)}</ul></SectionCard><NotBackfilledState title="Historical expense trends not loaded" description="Expense comparisons before January 2026 are not yet backfilled and are excluded from this overview." /></div>
</AppShell>; }
