// Base URL: use VITE_API_URL env var in production, fall back to /api (proxied in dev)
const BASE = (import.meta.env.VITE_API_URL ?? '') + '/api'

function getToken(): string | null {
  return localStorage.getItem('pb_token')
}

function authHeaders(): HeadersInit {
  const token = getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers ?? {}),
    },
  })

  if (res.status === 401) {
    // Token missing/expired — clear it and send the user back to login
    localStorage.removeItem('pb_token')
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login'
    }
    throw new Error('Not authenticated')
  }

  if (!res.ok) {
    const text = await res.text()
    throw new Error(text || `HTTP ${res.status}`)
  }

  return res.json() as Promise<T>
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface LoginResponse {
  access_token: string
  token_type: string
}

export interface CurrentUser {
  id: string
  email: string
  name: string
  role: string
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const form = new URLSearchParams({ username: email, password })
  const res = await fetch(`${BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!res.ok) throw new Error('Invalid credentials')
  return res.json() as Promise<LoginResponse>
}

export function fetchCurrentUser(): Promise<CurrentUser> {
  return request<CurrentUser>('/auth/me')
}

// ── Cockpit ───────────────────────────────────────────────────────────────────

export interface CockpitSummary {
  revenue: {
    this_month: number
    monthly_goal: number
    pct_complete: number
    pacing_status: 'on_track' | 'at_risk' | 'behind'
    mom_pct_b2c: number
    mom_pct_b2b: number
    mom_pct_total: number
  }
  runway: {
    months: number
    cash_position: number
  }
  profit_loss: {
    this_month: number
  }
  trend: TrendMonth[]
  fy_target: number
  targets: {
    b2b: { actual: number; goal: number }
    b2c: { actual: number; goal: number }
    other: { actual: number; goal: number }
  }
  b2c: {
    members: number
    mrr: number
    arpu: number
    top_source: string
  }
  b2b: {
    bookings: number
    top_deal: string
    win_rate: number
    top_type: string
  }
  risks_opportunities: RiskItem[]
}

export interface TrendMonth {
  month: string
  b2c: number
  b2b: number
  other: number
}

export interface RiskItem {
  type: 'risk' | 'opportunity'
  text: string
}

function _statusToTraffic(s: string): 'on_track' | 'at_risk' | 'behind' {
  if (s === 'green') return 'on_track'
  if (s === 'amber') return 'at_risk'
  return 'behind'
}

export async function fetchCockpitSummary(): Promise<CockpitSummary> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/cockpit/summary')
  const bl = raw.bottom_line ?? {}
  const c = raw.callouts ?? {}
  const t = raw.targets ?? {}
  const conv = raw.converting ?? {}
  const b2c = conv.b2c ?? {}
  const b2b = conv.b2b ?? {}
  return {
    revenue: {
      this_month: bl.revenue_mtd ?? 0,
      monthly_goal: bl.revenue_target ?? 0,
      pct_complete: bl.revenue_pct ?? 0,
      pacing_status: _statusToTraffic(bl.revenue_status ?? 'red'),
      mom_pct_b2c: c.b2c_mom ?? 0,
      mom_pct_b2b: c.b2b_mom ?? 0,
      mom_pct_total: c.total_mom ?? 0,
    },
    runway: {
      months: bl.runway_months ?? 0,
      cash_position: bl.cash_balance ?? 0,
    },
    profit_loss: {
      this_month: bl.month_profit ?? 0,
    },
    trend: (raw.revenue_trend ?? []).map((m: any) => ({
      month: m.month ?? m.label ?? '',
      b2c: m.b2c ?? 0,
      b2b: m.b2b ?? 0,
      other: m.other ?? 0,
    })),
    fy_target: (t.fy_b2b ?? 0) + (t.fy_b2c ?? 0) + (t.fy_other ?? 0),
    targets: {
      b2b: { actual: t.ytd_b2b ?? 0, goal: t.fy_b2b ?? 620_000 },
      b2c: { actual: t.ytd_b2c ?? 0, goal: t.fy_b2c ?? 180_000 },
      other: { actual: t.ytd_other ?? 0, goal: t.fy_other ?? 180_000 },
    },
    b2c: {
      members: b2c.new_members_mtd ?? 0,
      mrr: b2c.mrr ?? 0,
      arpu: b2c.arpu ?? 0,
      top_source: b2c.top_source ?? '—',
    },
    b2b: {
      bookings: b2b.bookings_value ?? 0,
      top_deal: b2b.top_deal?.company ?? '—',
      win_rate: b2b.win_rate_90d ?? 0,
      top_type: b2b.top_type ?? '—',
    },
    risks_opportunities: (raw.signals ?? []).map((s: any) => ({
      type: s.type as 'risk' | 'opportunity',
      text: s.message ?? '',
    })),
  }
}

// ── B2C ───────────────────────────────────────────────────────────────────────

export interface B2CMetrics {
  members_today: number
  revenue_today: number
  status: 'on_track' | 'at_risk' | 'behind'
  mtd_revenue: number
  mtd_goal: number
  mtd_pct: number
  mrr: number
  arr: number
  refund_count: number
  refund_amount: number
  churn_rate: number
  processor_split: ProcessorSplit[]
}

export interface ProcessorSplit {
  processor: string
  amount: number
  pct: number
}

export interface TrendDay {
  date: string
  members: number
  revenue: number
}

export interface AcquisitionSource {
  source: string
  count: number
  pct: number
}

export interface SubscriptionHealth {
  mrr: number
  arr: number
  mrr_growth_mom: number
  active_subscribers: number
  churned_this_month: number
  new_this_month: number
}

export async function fetchB2CMetrics(): Promise<B2CMetrics> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/b2c/metrics')
  const pace = raw.pace_pct ?? 0
  const status: B2CMetrics['status'] = pace >= 90 ? 'on_track' : pace >= 60 ? 'at_risk' : 'behind'
  return {
    members_today: raw.new_today ?? 0,
    revenue_today: raw.revenue_today_net ?? 0,
    status,
    mtd_revenue: raw.revenue_mtd_net ?? 0,
    mtd_goal: raw.monthly_target ?? 0,
    mtd_pct: pace,
    mrr: raw.mrr ?? 0,
    arr: raw.arr ?? 0,
    refund_count: raw.refunds_mtd ?? 0,
    refund_amount: 0,
    churn_rate: 0,
    processor_split: [],
  }
}

export async function fetchB2CTrend(days = 90): Promise<TrendDay[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any[]>(`/b2c/trend?days=${days}`)
  return raw.map((r) => ({
    date: r.date ?? '',
    members: r.new_members ?? 0,
    revenue: r.revenue_net ?? r.revenue_gross ?? 0,
  }))
}

export async function fetchB2CSources(): Promise<AcquisitionSource[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any[]>('/b2c/sources')
  const total = raw.reduce((s, r) => s + (r.count ?? 0), 0)
  return raw.map((r) => ({
    source: r.source ?? 'unknown',
    count: r.count ?? 0,
    pct: total > 0 ? Math.round((r.count / total) * 100) : 0,
  }))
}

export async function fetchB2CProcessors(): Promise<ProcessorSplit[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any[]>('/b2c/processors')
  const total = raw.reduce((s, r) => s + (r.gross ?? 0), 0)
  return raw.map((r) => ({
    processor: r.processor ?? 'unknown',
    amount: r.gross ?? 0,
    pct: total > 0 ? Math.round((r.gross / total) * 100) : 0,
  }))
}

export async function fetchB2CSubscriptionHealth(): Promise<SubscriptionHealth> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/b2c/subscription-health')
  const trend: Array<{ mrr: number }> = raw.mrr_trend ?? []
  const lastMrr = trend.length > 0 ? trend[trend.length - 1].mrr : 0
  const prevMrr = trend.length > 1 ? trend[trend.length - 2].mrr : 0
  const mrrGrowth = prevMrr > 0 ? Math.round(((lastMrr - prevMrr) / prevMrr) * 1000) / 10 : 0
  return {
    mrr: raw.mrr ?? 0,
    arr: raw.arr ?? 0,
    mrr_growth_mom: mrrGrowth,
    active_subscribers: (raw.active_monthly ?? 0) + (raw.active_annual ?? 0) + (raw.founding ?? 0),
    churned_this_month: 0,
    new_this_month: 0,
  }
}

// ── B2B ───────────────────────────────────────────────────────────────────────

export interface B2BMetrics {
  pipeline_value: number
  bookings_mtd: number
  bookings_target: number
  bookings_pct: number
  win_rate: number
  avg_deal_size: number
  open_deals: number
}

export interface PipelineStage {
  stage: string
  count: number
  value: number
}

export interface Deal {
  id: string
  name: string
  stage: string
  value: number
  owner: string
  type: string
  source: string
  close_date: string
  probability: number
}

export interface DealVelocity {
  stage: string
  avg_days: number
}

export interface Renewal {
  id: string
  name: string
  value: number
  renewal_date: string
  status: string
}

export async function fetchB2BMetrics(): Promise<B2BMetrics> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/b2b/metrics')
  const pipelineValue = raw.open_pipeline_value ?? 0
  const openDeals = raw.open_deal_count ?? 0
  const qt = raw.quarter_target ?? 0
  const bMtd = raw.bookings_mtd ?? 0
  return {
    pipeline_value: pipelineValue,
    bookings_mtd: bMtd,
    bookings_target: qt,
    bookings_pct: qt > 0 ? Math.round((bMtd / qt) * 100) : 0,
    win_rate: raw.win_rate_90d ?? 0,
    avg_deal_size: openDeals > 0 ? Math.round(pipelineValue / openDeals) : 0,
    open_deals: openDeals,
  }
}

export function fetchB2BPipeline(): Promise<PipelineStage[]> {
  return request<PipelineStage[]>('/b2b/pipeline')
}

export async function fetchB2BDeals(limit = 10, status = 'open'): Promise<Deal[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>(`/b2b/deals?limit=${limit}&status=${status}`)
  const items = raw.items ?? raw ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return items.map((d: any) => ({
    id: d.id ?? '',
    name: d.name ?? d.company ?? '',
    stage: d.stage ?? '',
    value: d.amount ?? 0,
    owner: d.owner ?? '',
    type: d.deal_type ?? d.type ?? '',
    source: d.source ?? '',
    close_date: d.close_date_expected ?? d.close_date_actual ?? '',
    probability: 0,
  }))
}

export function fetchB2BVelocity(): Promise<DealVelocity[]> {
  return request<DealVelocity[]>('/b2b/velocity')
}

export async function fetchB2BRenewals(): Promise<Renewal[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/b2b/renewals')
  if (!raw.has_data) return []
  const buckets = raw.buckets ?? {}
  const all: Renewal[] = []
  for (const [bucket, deals] of Object.entries(buckets)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const d of deals as any[]) {
      const daysAway = d.days_away ?? 999
      const status = daysAway <= 30 ? 'at_risk' : daysAway <= 60 ? 'pending' : 'confirmed'
      all.push({
        id: `${bucket}-${d.company}-${d.end_date}`,
        name: d.company ?? '',
        value: d.amount ?? 0,
        renewal_date: d.end_date ?? '',
        status,
      })
    }
  }
  return all.sort((a, b) => a.renewal_date.localeCompare(b.renewal_date))
}

// ── Financial ─────────────────────────────────────────────────────────────────

export interface FinancialSummary {
  cash_position: number
  runway_months: number
  revenue_ytd: number
  revenue_ytd_target: number
  revenue_ytd_pct: number
  net_profit_loss_mtd: number
  total_expenses_mtd: number
  gross_margin_pct: number
}

export interface RevenueMonth {
  month: string
  revenue: number
  target: number
  expenses: number
}

export interface ExpenseCategory {
  category: string
  amount: number
  pct: number
}

export interface SummitTracker {
  event_name: string
  date: string
  revenue_goal: number
  revenue_actual: number
  tickets_sold: number
  tickets_goal: number
  status: string
}

export async function fetchFinancialSummary(): Promise<FinancialSummary> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/financial/summary')
  const monthRev = raw.month_revenue ?? 0
  const monthExp = raw.month_expenses ?? 0
  const grossMargin = monthRev > 0 ? Math.round(((monthRev - monthExp) / monthRev) * 100) : 0
  return {
    cash_position: raw.cash_balance ?? 0,
    runway_months: raw.runway_months ?? 0,
    revenue_ytd: raw.ytd_revenue ?? 0,
    revenue_ytd_target: raw.fy_target ?? 980_000,
    revenue_ytd_pct: raw.ytd_pct ?? 0,
    net_profit_loss_mtd: raw.month_profit ?? 0,
    total_expenses_mtd: monthExp,
    gross_margin_pct: grossMargin,
  }
}

export async function fetchRevenueTrend(): Promise<RevenueMonth[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any[]>('/financial/revenue-trend?months=12')
  return raw.map((r) => ({
    month: r.label ?? r.month ?? '',
    revenue: (r.b2c ?? 0) + (r.b2b ?? 0) + (r.other ?? 0),
    target: 0,
    expenses: 0,
  }))
}

export async function fetchExpenses(): Promise<ExpenseCategory[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any[]>('/financial/expenses')
  const total = raw.reduce((s, r) => s + (r.amount ?? 0), 0)
  return raw.map((r) => ({
    category: (r.category ?? '').replace('expense_', '').replace(/_/g, ' '),
    amount: r.amount ?? 0,
    pct: total > 0 ? Math.round((r.amount / total) * 100) : 0,
  }))
}

export async function fetchSummitTracker(): Promise<SummitTracker[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/financial/summit')
  if (!raw.has_data) return []
  const pct = (raw.ticket_registrations ?? 0) / (raw.ticket_target ?? 1) * 100
  const status = pct >= 80 ? 'on_track' : pct >= 50 ? 'at_risk' : 'behind'
  return [
    {
      event_name: 'PLAYBOOK Summit',
      date: raw.summit_date ?? '',
      revenue_goal: raw.total_summit_costs ?? 0,
      revenue_actual: raw.revenue_raised_to_date ?? 0,
      tickets_sold: raw.ticket_registrations ?? 0,
      tickets_goal: raw.ticket_target ?? 200,
      status,
    },
  ]
}

// ── Reports ───────────────────────────────────────────────────────────────────

export interface Report {
  id: string
  type: string
  period: string
  status: 'pending' | 'processing' | 'ready' | 'failed'
  created_at: string
  download_pdf?: string
  download_zip?: string
}

export interface CreateReportPayload {
  type: string
  date_from: string
  date_to: string
  label: string
  send_email: boolean
}

export async function fetchReports(): Promise<Report[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any[]>('/reports')
  return raw.map((r) => ({
    id: r.id,
    type: r.report_type ?? r.type ?? 'adhoc',
    period: r.period_label ?? r.period ?? '',
    status: r.status === 'done' ? 'ready' : r.status === 'generating' ? 'processing' : r.status,
    created_at: r.created_at ?? '',
    download_pdf: r.has_pdf ? `/api/reports/${r.id}/download/pdf` : undefined,
    download_zip: r.has_zip ? `/api/reports/${r.id}/download/zip` : undefined,
  }))
}

export async function createReport(payload: CreateReportPayload): Promise<Report> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>('/reports', {
    method: 'POST',
    body: JSON.stringify({
      period_start: payload.date_from,
      period_end: payload.date_to,
      period_label: payload.label,
      send_email: payload.send_email,
    }),
  })
  return {
    id: raw.id,
    type: raw.report_type ?? 'adhoc',
    period: raw.period_label ?? '',
    status: raw.status === 'done' ? 'ready' : raw.status === 'generating' ? 'processing' : raw.status,
    created_at: raw.created_at ?? '',
  }
}

export async function fetchReportStatus(id: string): Promise<Report> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await request<any>(`/reports/${id}`)
  return {
    id: raw.id,
    type: raw.report_type ?? 'adhoc',
    period: raw.period_label ?? '',
    status: raw.status === 'done' ? 'ready' : raw.status === 'generating' ? 'processing' : raw.status,
    created_at: raw.created_at ?? '',
    download_pdf: raw.has_pdf ? `/api/reports/${raw.id}/download/pdf` : undefined,
    download_zip: raw.has_zip ? `/api/reports/${raw.id}/download/zip` : undefined,
  }
}

export function downloadReportUrl(id: string, format: 'pdf' | 'zip'): string {
  const token = getToken()
  return `${BASE}/reports/${id}/download/${format}?token=${token ?? ''}`
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export function submitIban(iban: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('/admin/iban', {
    method: 'POST',
    body: JSON.stringify({ iban }),
  })
}
