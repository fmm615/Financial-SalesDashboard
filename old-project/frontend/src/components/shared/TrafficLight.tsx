import { clsx, TRAFFIC_COLORS, type TrafficStatus } from '../../lib/utils'

interface TrafficLightProps {
  status: TrafficStatus
  label?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE_DOT: Record<string, string> = {
  sm: 'w-2 h-2',
  md: 'w-3 h-3',
  lg: 'w-4 h-4',
}

const SIZE_TEXT: Record<string, string> = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-base',
}

const STATUS_LABEL: Record<TrafficStatus, string> = {
  green: 'On Track',
  amber: 'At Risk',
  red: 'Behind',
}

export default function TrafficLight({
  status,
  label,
  size = 'md',
  className,
}: TrafficLightProps) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5', className)}>
      <span
        className={clsx(SIZE_DOT[size], 'rounded-full shrink-0')}
        style={{ backgroundColor: TRAFFIC_COLORS[status] }}
      />

      <span
        className={clsx(
          SIZE_TEXT[size],
          'font-medium text-gray-700'
        )}
        style={{ color: TRAFFIC_COLORS[status] }}
      >
        {label ?? STATUS_LABEL[status]}
      </span>
    </span>
  )
}