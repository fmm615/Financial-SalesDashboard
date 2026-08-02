import { ReactNode } from 'react'
import { clsx, TRAFFIC_BG, TRAFFIC_TEXT, type TrafficStatus } from '../../lib/utils'

interface MetricCardProps {
  label: string
  value: string
  sub?: string
  status?: TrafficStatus
  badge?: string
  children?: ReactNode
  className?: string
}

export default function MetricCard({
  label,
  value,
  sub,
  status,
  badge,
  children,
  className,
}: MetricCardProps) {
  return (
    <div
      className={clsx(
        'rounded-xl border border-gray-200 bg-white shadow-sm p-5 flex flex-col gap-1',
        status ? TRAFFIC_BG[status] : '',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wider text-gray-600">
          {label}
        </p>

        {badge && (
          <span
            className={clsx(
              'text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0',
              status ? TRAFFIC_TEXT[status] : 'text-gray-600',
              'border-current/30',
            )}
          >
            {badge}
          </span>
        )}
      </div>

      <p
        className={clsx(
          'text-3xl font-bold leading-none',
          status ? TRAFFIC_TEXT[status] : 'text-[#2A004C]',
        )}
      >
        {value}
      </p>

      {sub && (
        <p className="text-xs text-gray-600 mt-0.5">
          {sub}
        </p>
      )}

      {children}
    </div>
  )
}