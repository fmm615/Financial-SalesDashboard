import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts'
import {
  fetchB2CMetrics,
  fetchB2CTrend,
  fetchB2CSources,
  fetchB2CSubscriptionHealth,
  fetchB2CProcessors,
} from '../../lib/api'
import MetricCard from '../../components/shared/MetricCard'
import TrafficLight from '../../components/shared/TrafficLight'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'
import { formatCurrency, formatPct, formatNumber, pacingStatusToTraffic } from '../../lib/utils'

const DAYS_OPTIONS = [30, 60, 90] as const
const CHART_COLORS = ['#2A004C', '#4c1d95', '#7c3aed', '#a78bfa', '#C8FF00']

export default function B2CTab() {
  const [days, setDays] = useState<30 | 60 | 90>(90)

  const metricsQ = useQuery({ queryKey: ['b2c-metrics'], queryFn: fetchB2CMetrics })
  const trendQ = useQuery({ queryKey: ['b2c-trend', days], queryFn: () => fetchB2CTrend(days) })
  const sourcesQ = useQuery({ queryKey: ['b2c-sources'], queryFn: fetchB2CSources })
  const healthQ = useQuery({ queryKey: ['b2c-health'], queryFn: fetchB2CSubscriptionHealth })
  const processorsQ = useQuery({ queryKey: ['b2c-processors'], queryFn: fetchB2CProcessors })

  const m = metricsQ.data
  const trend = trendQ.data ?? []
  const sources = sourcesQ.data ?? []
  const health = healthQ.data
  const processors = processorsQ.data ?? []

  const status = m ? pacingStatusToTraffic(m.status) : 'amber'

  return (
    <div className="space-y-8">
      {/* Today's Pulse */}
      <section>
        <h3 className="section-label">Today's Pulse</h3>
        {metricsQ.isLoading ? (
          <LoadingSpinner />
        ) : !m ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricCard
              label="Members Today"
              value={formatNumber(m.members_today)}
              status={status}
            />
            <MetricCard
              label="Revenue Today"
              value={formatCurrency(m.revenue_today)}
              status={status}
            />
            <MetricCard
              label="MTD Revenue"
              value={formatCurrency(m.mtd_revenue)}
              sub={`${formatPct(m.mtd_pct)} of ${formatCurrency(m.mtd_goal, true)}`}
              status={status}
            >
              <TrafficLight status={status} size="sm" className="mt-1" />
            </MetricCard>
            <MetricCard label="Churn Rate" value={formatPct(m.churn_rate)} />
          </div>
        )}
      </section>

      {/* 90-day Trend */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h3 className="section-label mb-0">Trend</h3>
          <div className="flex gap-1">
            {DAYS_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  days === d
                    ? 'bg-[#C8FF00]/20 text-[#C8FF00]'
                    : 'text-gray-400 hover:text-[#2A004C] hover:bg-white/10'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4">
          {trendQ.isLoading ? (
            <LoadingSpinner />
          ) : trend.length === 0 ? (
            <EmptyState />
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="b2cRevGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#C8FF00" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#C8FF00" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fill: '#9ca3af', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: '#9ca3af', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
                  width={44}
                />
                <Tooltip
                  contentStyle={{ background: '#1a0036', border: '1px solid #4c1d95', borderRadius: 8 }}
                  labelStyle={{ color: '#e9d5ff', fontSize: 11 }}
                  formatter={(value: number) => [formatCurrency(value), 'Revenue']}
                />
                <Area
                  type="monotone"
                  dataKey="revenue"
                  stroke="#C8FF00"
                  strokeWidth={2}
                  fill="url(#b2cRevGrad)"
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Acquisition Sources + Processor Split */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <section>
          <h3 className="section-label">Acquisition Sources</h3>
          <div className="bg-white/5 border border-white/10 rounded-xl p-4">
            {sourcesQ.isLoading ? (
              <LoadingSpinner />
            ) : sources.length === 0 ? (
              <EmptyState />
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={sources} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                  <XAxis type="number" tick={{ fill: '#9ca3af', fontSize: 10 }} axisLine={false} tickLine={false} />
                  <YAxis
                    type="category"
                    dataKey="source"
                    tick={{ fill: '#9ca3af', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    width={70}
                  />
                  <Tooltip
                    contentStyle={{ background: '#1a0036', border: '1px solid #4c1d95', borderRadius: 8 }}
                    labelStyle={{ color: '#e9d5ff', fontSize: 11 }}
                    formatter={(value: number) => [formatNumber(value), 'Members']}
                  />
                  <Bar dataKey="count" fill="#C8FF00" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        <section>
          <h3 className="section-label">Processor Split</h3>
          <div className="bg-white/5 border border-white/10 rounded-xl p-4">
            {processorsQ.isLoading ? (
              <LoadingSpinner />
            ) : processors.length === 0 ? (
              <EmptyState />
            ) : (
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie
                    data={processors}
                    dataKey="amount"
                    nameKey="processor"
                    cx="50%"
                    cy="50%"
                    outerRadius={65}
                    innerRadius={35}
                  >
                    {processors.map((_, idx) => (
                      <Cell key={idx} fill={CHART_COLORS[idx % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#1a0036', border: '1px solid #4c1d95', borderRadius: 8 }}
                    formatter={(value: number) => [formatCurrency(value), 'Volume']}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#9ca3af' }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      </div>

      {/* Subscription Health */}
      <section>
        <h3 className="section-label">Subscription Health</h3>
        {healthQ.isLoading ? (
          <LoadingSpinner />
        ) : !health ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <MetricCard label="MRR" value={formatCurrency(health.mrr)} sub="Monthly recurring revenue" />
            <MetricCard label="ARR" value={formatCurrency(health.arr, true)} sub="Annual recurring revenue" />
            <MetricCard
              label="MRR Growth MoM"
              value={`${health.mrr_growth_mom >= 0 ? '+' : ''}${health.mrr_growth_mom.toFixed(1)}%`}
              status={health.mrr_growth_mom >= 0 ? 'green' : 'red'}
            />
            <MetricCard label="Active Subscribers" value={formatNumber(health.active_subscribers)} />
            <MetricCard label="New This Month" value={formatNumber(health.new_this_month)} />
            <MetricCard label="Churned This Month" value={formatNumber(health.churned_this_month)} status="red" />
          </div>
        )}
      </section>

      {/* Refunds */}
      {m && (
        <section>
          <h3 className="section-label">Refunds</h3>
          <div className="grid grid-cols-2 gap-4">
            <MetricCard label="Refund Count" value={formatNumber(m.refund_count)} status="amber" />
            <MetricCard label="Refund Amount" value={formatCurrency(m.refund_amount)} status="amber" />
          </div>
        </section>
      )}
    </div>
  )
}
