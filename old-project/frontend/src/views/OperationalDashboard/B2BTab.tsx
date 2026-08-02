import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  FunnelChart,
  Funnel,
  LabelList,
} from 'recharts'
import {
  fetchB2BMetrics,
  fetchB2BPipeline,
  fetchB2BDeals,
  fetchB2BVelocity,
  fetchB2BRenewals,
  type Deal,
} from '../../lib/api'
import MetricCard from '../../components/shared/MetricCard'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'
import {
  formatCurrency,
  formatPct,
  formatNumber,
  formatDate,
} from '../../lib/utils'

export default function B2BTab() {
  const metricsQ = useQuery({ queryKey: ['b2b-metrics'], queryFn: fetchB2BMetrics })
  const pipelineQ = useQuery({ queryKey: ['b2b-pipeline'], queryFn: fetchB2BPipeline })
  const dealsQ = useQuery({ queryKey: ['b2b-deals'], queryFn: () => fetchB2BDeals(10, 'open') })
  const velocityQ = useQuery({ queryKey: ['b2b-velocity'], queryFn: fetchB2BVelocity })
  const renewalsQ = useQuery({ queryKey: ['b2b-renewals'], queryFn: fetchB2BRenewals })

  const m = metricsQ.data
  const pipeline = pipelineQ.data ?? []
  const deals = dealsQ.data ?? []
  const velocity = velocityQ.data ?? []
  const renewals = renewalsQ.data ?? []

  const funnelData = pipeline.map((s, i) => ({
    name: s.stage,
    value: s.count,
    fill: ['#2A004C', '#3b0764', '#4c1d95', '#6d28d9', '#7c3aed'][i % 5],
  }))

  return (
    <div className="space-y-8">
      {/* Headline Metrics */}
      <section>
        <h3 className="section-label">Pipeline Overview</h3>
        {metricsQ.isLoading ? (
          <LoadingSpinner />
        ) : !m ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricCard
              label="Pipeline Value"
              value={formatCurrency(m.pipeline_value, true)}
            />
            <MetricCard
              label="Bookings MTD"
              value={formatCurrency(m.bookings_mtd, true)}
              sub={`${formatPct(m.bookings_pct)} of ${formatCurrency(m.bookings_target, true)}`}
              status={m.bookings_pct >= 80 ? 'green' : m.bookings_pct >= 50 ? 'amber' : 'red'}
            />
            <MetricCard label="Win Rate" value={formatPct(m.win_rate)} />
            <MetricCard label="Avg Deal Size" value={formatCurrency(m.avg_deal_size)} />
          </div>
        )}
      </section>

      {/* Pipeline by Stage + Funnel */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <section>
          <h3 className="section-label">Pipeline by Stage</h3>
          <div className="bg-white border border-gray-200 shadow-sm rounded-xl p-4">
            {pipelineQ.isLoading ? (
              <LoadingSpinner />
            ) : pipeline.length === 0 ? (
              <EmptyState />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={pipeline} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="stage"
                    tick={{ fill: '#6B7280', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#6B7280', fontSize: 10 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => formatCurrency(v, true)}
                    width={52}
                  />
                  <Tooltip
                    contentStyle={{ background: '#ffffff', border: '1px solid #E5E7EB',borderRadius: 8,}}                    formatter={(value: number) => [formatCurrency(value), 'Value']}
                  />
                  <Bar dataKey="value" fill="#C8FF00" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        <section>
          <h3 className="section-label">Deal Funnel</h3>
          <div className="bg-white border border-gray-200 shadow-sm rounded-xl p-4">
            {pipelineQ.isLoading ? (
              <LoadingSpinner />
            ) : funnelData.length === 0 ? (
              <EmptyState />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <FunnelChart>
                  <Tooltip
                    contentStyle={{ background: '#1a0036', border: '1px solid #4c1d95', borderRadius: 8 }}
                    formatter={(value: number) => [formatNumber(value), 'Deals']}
                  />
                  <Funnel dataKey="value" data={funnelData} isAnimationActive>
                    <LabelList
                      position="center"
                      fill="#2A004C"
                      stroke="none"
                      fontSize={11}
                      formatter={(value: number) => formatNumber(value)}
                    />
                  </Funnel>
                </FunnelChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      </div>

      {/* Deal Velocity */}
      <section>
        <h3 className="section-label">Deal Velocity (Avg Days per Stage)</h3>
        <div className="bg-white border border-gray-200 shadow-sm rounded-xl p-4">
          {velocityQ.isLoading ? (
            <LoadingSpinner />
          ) : velocity.length === 0 ? (
            <EmptyState />
          ) : (
            <ResponsiveContainer width="100%" height={150}>
              <BarChart data={velocity} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="stage"
                  tick={{ fill: '#6B7280', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#6B7280', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                  tickFormatter={(v) => `${v}d`}
                />
                <Tooltip
                  contentStyle={{ background: '#1a0036', border: '1px solid #4c1d95', borderRadius: 8 }}
                  formatter={(value: number) => [`${value} days`, 'Avg Time']}
                />
                <Bar dataKey="avg_days" fill="#2A004C" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Top 10 Deals Table */}
      <section>
        <h3 className="section-label">Top Open Deals</h3>
        <div className="bg-white border border-gray-200 shadow-sm rounded-xl overflow-hidden">
          {dealsQ.isLoading ? (
            <LoadingSpinner />
          ) : deals.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    {['Deal', 'Stage', 'Value', 'Owner', 'Type', 'Close Date', 'Prob'].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {deals.map((deal: Deal) => (
                    <tr key={deal.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-2.5 text-[#2A004C] font-medium truncate max-w-[160px]">
                        {deal.name}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700">{deal.stage}</td>
                      <td className="px-4 py-2.5 text-[#C8FF00] font-semibold">
                        {formatCurrency(deal.value, true)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700">{deal.owner}</td>
                      <td className="px-4 py-2.5 text-gray-700">{deal.type}</td>
                      <td className="px-4 py-2.5 text-gray-600">{formatDate(deal.close_date)}</td>
                      <td className="px-4 py-2.5 text-gray-600">{formatPct(deal.probability, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Renewals */}
      <section>
        <h3 className="section-label">Upcoming Renewals</h3>
        <div className="bg-white border border-gray-200 shadow-sm rounded-xl overflow-hidden">
          {renewalsQ.isLoading ? (
            <LoadingSpinner />
          ) : renewals.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200">
                    {['Account', 'Value', 'Renewal Date', 'Status'].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {renewals.map((r) => (
                    <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-2.5 text-[#2A004C] font-medium">{r.name}</td>
                      <td className="px-4 py-2.5 text-[#C8FF00] font-semibold">
                        {formatCurrency(r.value, true)}
                      </td>
                      <td className="px-4 py-2.5 text-gray-400">{formatDate(r.renewal_date)}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                            r.status === 'confirmed'
                              ? 'bg-[#C8FF00]/20 text-[#2A004C]'
                              : r.status === 'at_risk'
                              ? 'bg-red-100 text-red-600'
                              : 'bg-amber-100 text-amber-600'
                          }`}
                        >
                          {r.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
