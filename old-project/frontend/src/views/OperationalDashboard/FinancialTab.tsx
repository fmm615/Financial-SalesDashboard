import { useQuery } from '@tanstack/react-query'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts'
import {
  fetchFinancialSummary,
  fetchRevenueTrend,
  fetchExpenses,
  fetchSummitTracker,
} from '../../lib/api'
import MetricCard from '../../components/shared/MetricCard'
import LoadingSpinner from '../../components/shared/LoadingSpinner'
import EmptyState from '../../components/shared/EmptyState'
import {
  formatCurrency,
  formatPct,
  formatMonthShort,
  runwayStatus,
  profitStatus,
} from '../../lib/utils'

const EXPENSE_COLORS = ['#2A004C', '#4c1d95', '#7c3aed', '#a78bfa', '#C8FF00', '#a6d600']

export default function FinancialTab() {
  const summaryQ = useQuery({ queryKey: ['financial-summary'], queryFn: fetchFinancialSummary })
  const trendQ = useQuery({ queryKey: ['financial-trend'], queryFn: fetchRevenueTrend })
  const expensesQ = useQuery({ queryKey: ['financial-expenses'], queryFn: fetchExpenses })
  const summitQ = useQuery({ queryKey: ['financial-summit'], queryFn: fetchSummitTracker })

  const s = summaryQ.data
  const trend = trendQ.data ?? []
  const expenses = expensesQ.data ?? []
  const summits = summitQ.data ?? []

  const rwStatus = s ? runwayStatus(s.runway_months) : 'amber'
  const plStatus = s ? profitStatus(s.net_profit_loss_mtd) : 'amber'

  const chartData = trend.map((m) => ({
    ...m,
    label: formatMonthShort(m.month),
    profit: m.revenue - m.expenses,
  }))

  return (
    <div className="space-y-8">
      {/* Cash & Runway */}
      <section>
        <h3 className="section-label">Cash & Runway</h3>
        {summaryQ.isLoading ? (
          <LoadingSpinner />
        ) : !s ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricCard
              label="Cash Position"
              value={formatCurrency(s.cash_position, true)}
            />
            <MetricCard
              label="Runway"
              value={`${s.runway_months.toFixed(1)} mo`}
              status={rwStatus}
              badge={rwStatus === 'green' ? 'Healthy' : rwStatus === 'amber' ? 'Monitor' : 'Critical'}
            />
            <MetricCard
              label="Net Profit/(Loss) MTD"
              value={formatCurrency(s.net_profit_loss_mtd)}
              status={plStatus}
            />
            <MetricCard
              label="Gross Margin"
              value={formatPct(s.gross_margin_pct)}
              status={s.gross_margin_pct >= 60 ? 'green' : s.gross_margin_pct >= 40 ? 'amber' : 'red'}
            />
          </div>
        )}
      </section>

      {/* Revenue YTD */}
      {s && (
        <section>
          <h3 className="section-label">Revenue YTD vs Target</h3>
          <div className="bg-white/5 border border-white/10 rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-2xl font-bold text-[#2A004C]">{formatCurrency(s.revenue_ytd, true)}</span>
              <span className="text-sm text-gray-400">
                {formatPct(s.revenue_ytd_pct)} of {formatCurrency(s.revenue_ytd_target, true)} target
              </span>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-[#C8FF00] transition-all"
                style={{ width: `${Math.min(100, s.revenue_ytd_pct)}%` }}
              />
            </div>
          </div>
        </section>
      )}

      {/* Monthly Revenue Trend (12 mo) */}
      <section>
        <h3 className="section-label">Monthly Revenue Trend (12 Months)</h3>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4">
          {trendQ.isLoading ? (
            <LoadingSpinner />
          ) : chartData.length === 0 ? (
            <EmptyState />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#9ca3af', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#9ca3af', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
                  width={48}
                />
                <Tooltip
                  contentStyle={{ background: '#1a0036', border: '1px solid #4c1d95', borderRadius: 8 }}
                  formatter={(value: number, name: string) => [formatCurrency(value), name]}
                />
                <Bar dataKey="revenue" name="Revenue" fill="#C8FF00" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill="#D32F2F" radius={[4, 4, 0, 0]} />
                {chartData[0]?.target && (
                  <ReferenceLine
                    y={chartData[0].target}
                    stroke="#a6d600"
                    strokeDasharray="4 3"
                    label={{ value: 'Target', fill: '#a6d600', fontSize: 10, position: 'insideTopRight' }}
                  />
                )}
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Profit/Loss Trend */}
      <section>
        <h3 className="section-label">Profit / Loss Trend</h3>
        <div className="bg-white/5 border border-white/10 rounded-xl p-4">
          {trendQ.isLoading ? (
            <LoadingSpinner />
          ) : chartData.length === 0 ? (
            <EmptyState />
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <XAxis
                  dataKey="label"
                  tick={{ fill: '#9ca3af', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#9ca3af', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`}
                  width={48}
                />
                <Tooltip
                  contentStyle={{ background: '#1a0036', border: '1px solid #4c1d95', borderRadius: 8 }}
                  formatter={(value: number) => [formatCurrency(value), 'Profit/(Loss)']}
                />
                <ReferenceLine y={0} stroke="#9ca3af" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="profit"
                  stroke="#C8FF00"
                  strokeWidth={2}
                  dot={{ fill: '#C8FF00', r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Expense Breakdown + P&L Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        <section>
          <h3 className="section-label">Expense Breakdown</h3>
          <div className="bg-white/5 border border-white/10 rounded-xl p-4">
            {expensesQ.isLoading ? (
              <LoadingSpinner />
            ) : expenses.length === 0 ? (
              <EmptyState />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={expenses}
                    dataKey="amount"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    outerRadius={65}
                    innerRadius={30}
                  >
                    {expenses.map((_, idx) => (
                      <Cell key={idx} fill={EXPENSE_COLORS[idx % EXPENSE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ background: '#1a0036', border: '1px solid #4c1d95', borderRadius: 8 }}
                    formatter={(value: number) => [formatCurrency(value), 'Amount']}
                  />
                  <Legend wrapperStyle={{ fontSize: 10, color: '#9ca3af' }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {s && (
          <section>
            <h3 className="section-label">P&L Summary</h3>
            <div className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-3">
              {[
                { label: 'Total Revenue MTD', value: formatCurrency(s.net_profit_loss_mtd + s.total_expenses_mtd), highlight: false },
                { label: 'Total Expenses MTD', value: formatCurrency(s.total_expenses_mtd), highlight: false },
                { label: 'Net Profit / (Loss)', value: formatCurrency(s.net_profit_loss_mtd), highlight: true },
              ].map(({ label, value, highlight }) => (
                <div
                  key={label}
                  className={`flex justify-between items-center py-2 border-b border-white/10 last:border-0 ${
                    highlight ? 'border-t border-white/20 pt-3' : ''
                  }`}
                >
                  <span className={`text-sm ${highlight ? 'font-semibold text-[#2A004C]' : 'text-gray-400'}`}>
                    {label}
                  </span>
                  <span
                    className={`text-sm font-bold ${
                      highlight
                        ? s.net_profit_loss_mtd >= 0
                          ? 'text-[#C8FF00]'
                          : 'text-red-400'
                        : 'text-gray-200'
                    }`}
                  >
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {/* Summit Tracker */}
      <section>
        <h3 className="section-label">Summit Tracker</h3>
        {summitQ.isLoading ? (
          <LoadingSpinner />
        ) : summits.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {summits.map((summit) => {
              const ticketPct = (summit.tickets_sold / summit.tickets_goal) * 100
              const revPct = (summit.revenue_actual / summit.revenue_goal) * 100
              return (
                <div
                  key={summit.event_name}
                  className="bg-white/5 border border-white/10 rounded-xl p-5 space-y-3"
                >
                  <div className="flex justify-between items-start">
                    <p className="font-semibold text-[#2A004C]">{summit.event_name}</p>
                    <span
                      className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        summit.status === 'on_track'
                          ? 'bg-lime-900/40 text-[#C8FF00]'
                          : summit.status === 'at_risk'
                          ? 'bg-amber-900/40 text-amber-400'
                          : 'bg-red-900/40 text-red-400'
                      }`}
                    >
                      {summit.status.replace('_', ' ')}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500">{summit.date}</p>
                  <div className="space-y-2">
                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Tickets Sold</span>
                        <span>
                          {summit.tickets_sold} / {summit.tickets_goal} ({formatPct(ticketPct)})
                        </span>
                      </div>
                      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#C8FF00]"
                          style={{ width: `${Math.min(100, ticketPct)}%` }}
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>Revenue</span>
                        <span>
                          {formatCurrency(summit.revenue_actual, true)} / {formatCurrency(summit.revenue_goal, true)} ({formatPct(revPct)})
                        </span>
                      </div>
                      <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full bg-purple-500"
                          style={{ width: `${Math.min(100, revPct)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
