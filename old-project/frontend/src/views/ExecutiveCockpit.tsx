import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from 'recharts'
import { fetchCockpitSummary } from '../lib/api'
import MetricCard from '../components/shared/MetricCard'
import TrafficLight from '../components/shared/TrafficLight'
import LoadingSpinner from '../components/shared/LoadingSpinner'
import EmptyState from '../components/shared/EmptyState'
import {
  formatCurrency,
  formatPct,
  formatPctChange,
  formatMonthShort,
  pacingStatusToTraffic,
  runwayStatus,
  profitStatus,
  daysElapsedPctThisMonth,
  revenueStatus,
} from '../lib/utils'

function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-widest text-[#2A004C] mb-3">
      {title}
    </h2>
  )
}

function ProgressBar({ pct, color = '#C8FF00' }: { pct: number; color?: string }) {
  const clamped = Math.min(100, Math.max(0, pct))
  return (
        <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
        className="h-full rounded-full transition-all"
        style={{ width: `${clamped}%`, backgroundColor: color }}
      />
    </div>
  )
}

export default function ExecutiveCockpit() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['cockpit-summary'],
    queryFn: fetchCockpitSummary,
  })

  if (isLoading) return <LoadingSpinner size="lg" className="mt-24" />
  if (isError || !data) return <EmptyState className="mt-24" />

  const daysElapsed = daysElapsedPctThisMonth()
  const revStatus = pacingStatusToTraffic(data.revenue.pacing_status)
  const revActualStatus = revenueStatus(data.revenue.pct_complete, daysElapsed)
  const rwStatus = runwayStatus(data.runway.months)
  const plStatus = profitStatus(data.profit_loss.this_month)

  const chartData = data.trend.map((m) => ({
    ...m,
    label: formatMonthShort(m.month),
    total: m.b2c + m.b2b + m.other,
  }))

  return (
    <div className="max-w-5xl mx-auto px-4 pt-6 pb-16 space-y-10">
      {/* Section 1 — Bottom Line */}
      <section>
        <SectionHeader title="Bottom Line" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <MetricCard
            label="This Month's Revenue"
            value={formatCurrency(data.revenue.this_month)}
            sub={`${formatPct(data.revenue.pct_complete)} of ${formatCurrency(data.revenue.monthly_goal, true)} goal`}
            status={revActualStatus}
            badge={revStatus === 'green' ? 'On Pace' : revStatus === 'amber' ? 'At Risk' : 'Behind Pace'}
          >
            <ProgressBar pct={data.revenue.pct_complete} />
            <TrafficLight status={revStatus} size="sm" className="mt-1" />
          </MetricCard>

          <MetricCard
            label="Months of Runway"
            value={`${data.runway.months.toFixed(1)} mo`}
            sub={`Cash position: ${formatCurrency(data.runway.cash_position, true)}`}
            status={rwStatus}
            badge={rwStatus === 'green' ? 'Healthy' : rwStatus === 'amber' ? 'Monitor' : 'Critical'}
          >
            <TrafficLight status={rwStatus} size="sm" className="mt-1" />
          </MetricCard>

          <MetricCard
            label="Profit / (Loss) This Month"
            value={formatCurrency(data.profit_loss.this_month)}
            status={plStatus}
            badge={data.profit_loss.this_month >= 0 ? 'Profitable' : 'Loss'}
          >
            <TrafficLight
              status={plStatus}
              label={data.profit_loss.this_month >= 0 ? 'In the black' : 'In the red'}
              size="sm"
              className="mt-1"
            />
          </MetricCard>
        </div>
      </section>

      {/* Section 2 — Are We Growing? */}
      <section>
        <SectionHeader title="Are We Growing?" />
        <div className="bg-white border border-gray-200 shadow-sm rounded-xl p-5">
            {chartData.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fill: '#9ca3af', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#9ca3af', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
                    width={48}
                  />
                  <Tooltip
contentStyle={{
  background: '#ffffff',
  border: '1px solid #E5E7EB',
  borderRadius: 8,
}}
labelStyle={{
  color: '#2A004C',
  fontSize: 12,
}}
                    formatter={(value: number, name: string) => [formatCurrency(value), name]}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, color: '#6B7280', paddingTop: 8 }}
                  />
                  <Bar dataKey="b2c" name="B2C" stackId="a" fill="#2A004C" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="b2b" name="B2B" stackId="a" fill="#4c1d95" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="other" name="Other" stackId="a" fill="#7c3aed" radius={[4, 4, 0, 0]} />
                  {data.fy_target > 0 && (
                    <ReferenceLine
                      y={data.fy_target / 12}
                      stroke="#a6d600"
                      strokeDasharray="4 3"
                      label={{ value: 'Monthly Target', fill: '#a6d600', fontSize: 10, position: 'insideTopRight' }}
                    />
                  )}
                </BarChart>
              </ResponsiveContainer>

              {/* Auto callouts */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-4">
                {[
                  { label: 'B2C MoM', value: data.revenue.mom_pct_b2c },
                  { label: 'B2B MoM', value: data.revenue.mom_pct_b2b },
                  { label: 'Total MoM', value: data.revenue.mom_pct_total },
                ].map(({ label, value }) => (
                    <div key={label} className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm flex justify-between items-center">                    <span className="text-gray-600">{label}</span>
                    <span
                      className="font-semibold"
                      style={{ color: value >= 0 ? '#C8FF00' : '#D32F2F' }}
                    >
                      {formatPctChange(value)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </section>

      {/* Section 3 — Revenue Mix & Targets */}
      <section>
        <SectionHeader title="Revenue Mix & Targets" />
        <div className="bg-white border border-gray-200 shadow-sm rounded-xl p-5 space-y-5">
          {[
            { label: 'B2B', data: data.targets.b2b, goal: 620_000 },
            { label: 'B2C', data: data.targets.b2c, goal: 180_000 },
            { label: 'Other', data: data.targets.other, goal: 180_000 },
          ].map(({ label, data: d, goal }) => {
            const pct = (d.actual / goal) * 100
            return (
              <div key={label} className="space-y-1.5">
                <div className="flex justify-between text-sm">
                  <span className="font-medium text-[#2A004C]">{label}</span>
                  <span className="text-gray-600">
                    {formatCurrency(d.actual, true)} / {formatCurrency(goal, true)} ({formatPct(pct)})
                  </span>
                </div>
                <ProgressBar pct={pct} />
              </div>
            )
          })}
        </div>
      </section>

      {/* Section 4 — What's Converting */}
      <section>
        <SectionHeader title="What's Converting" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* B2C */}
          <div className="bg-white border border-gray-200 shadow-sm rounded-xl p-5 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#2A004C]">B2C</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Members', value: data.b2c.members.toLocaleString() },
                { label: 'MRR', value: formatCurrency(data.b2c.mrr, true) },
                { label: 'ARPU', value: formatCurrency(data.b2c.arpu) },
                { label: 'Top Source', value: data.b2c.top_source || '—' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
                  <p className="text-[#2A004C] font-semibold text-sm mt-0.5 truncate">{value}</p>
                </div>
              ))}
            </div>
          </div>

          {/* B2B */}
          <div className="bg-white border border-gray-200 shadow-sm rounded-xl p-5 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#2A004C]">B2B</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Bookings', value: formatCurrency(data.b2b.bookings, true) },
                { label: 'Top Deal', value: data.b2b.top_deal || '—' },
                { label: 'Win Rate', value: formatPct(data.b2b.win_rate) },
                { label: 'Top Type', value: data.b2b.top_type || '—' },
              ].map(({ label, value }) => (
                <div key={label}>
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
                  <p className="text-[#2A004C] font-semibold text-sm mt-0.5 truncate">{value}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Section 5 — Risks & Opportunities */}
      <section>
        <SectionHeader title="Risks & Opportunities" />
        <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-2">
          {data.risks_opportunities.length === 0 ? (
            <EmptyState />
          ) : (
            data.risks_opportunities.slice(0, 5).map((item, i) => (
              <div
                key={i}
                className={`flex items-start gap-3 px-3 py-2.5 rounded-lg text-sm ${
                  item.type === 'opportunity'
                    ? 'bg-[#C8FF00]/10 border border-[#C8FF00]/30'
                    : 'bg-red-900/20 border border-red-700/30'
                }`}
              >
                <span
                  className={`mt-0.5 shrink-0 w-2 h-2 rounded-full ${
                    item.type === 'opportunity' ? 'bg-[#C8FF00]' : 'bg-red-500'
                  }`}
                />
                <p className={item.type === 'opportunity' ? 'text-[#2A004C]' : 'text-red-200'}>
                  {item.text}
                </p>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
