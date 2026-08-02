// ── Currency ──────────────────────────────────────────────────────────────────

export function formatCurrency(value: number, compact = false): string {
  if (compact) {
    if (Math.abs(value) >= 1_000_000) {
      return `$${(value / 1_000_000).toFixed(1)}M`
    }
    if (Math.abs(value) >= 1_000) {
      return `$${(value / 1_000).toFixed(0)}K`
    }
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)
}

// ── Percentage ────────────────────────────────────────────────────────────────

export function formatPct(value: number, decimals = 1): string {
  return `${value >= 0 ? '' : ''}${value.toFixed(decimals)}%`
}

export function formatPctChange(value: number, decimals = 1): string {
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(decimals)}%`
}

// ── Numbers ───────────────────────────────────────────────────────────────────

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatCompact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`
  return String(value)
}

// ── Dates ─────────────────────────────────────────────────────────────────────

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

export function formatMonthShort(iso: string): string {
  return new Date(iso + '-01').toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

// ── Traffic light ─────────────────────────────────────────────────────────────

export type TrafficStatus = 'green' | 'amber' | 'red'

export function revenueStatus(pctComplete: number, daysElapsedPct: number): TrafficStatus {
  const expectedPct = daysElapsedPct * 100
  const gap = pctComplete - expectedPct
  if (gap >= -5) return 'green'
  if (gap >= -15) return 'amber'
  return 'red'
}

export function runwayStatus(months: number): TrafficStatus {
  if (months >= 6) return 'green'
  if (months >= 3) return 'amber'
  return 'red'
}

export function profitStatus(value: number): TrafficStatus {
  if (value > 0) return 'green'
  if (value > -5000) return 'amber'
  return 'red'
}

export function pacingStatusToTraffic(status: string): TrafficStatus {
  if (status === 'on_track') return 'green'
  if (status === 'at_risk') return 'amber'
  return 'red'
}

export const TRAFFIC_COLORS: Record<TrafficStatus, string> = {
  green: '#C8FF00',
  amber: '#F59E0B',
  red: '#D32F2F',
}

export const TRAFFIC_BG: Record<TrafficStatus, string> = {
  green: 'bg-lime-900/30 border-lime-500/40',
  amber: 'bg-amber-900/30 border-amber-500/40',
  red: 'bg-red-900/30 border-red-500/40',
}

export const TRAFFIC_TEXT: Record<TrafficStatus, string> = {
  green: 'text-[#C8FF00]',
  amber: 'text-amber-400',
  red: 'text-red-400',
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function clsx(...classes: (string | undefined | false | null)[]): string {
  return classes.filter(Boolean).join(' ')
}

export function daysElapsedPctThisMonth(): number {
  const now = new Date()
  const totalDays = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
  return now.getDate() / totalDays
}
