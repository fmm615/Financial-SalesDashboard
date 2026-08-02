interface EmptyStateProps {
  message?: string
  className?: string
}

export default function EmptyState({
  message = 'No data available for this period — backfill pending.',
  className = '',
}: EmptyStateProps) {
  return (
    <div className={`flex items-center justify-center py-10 ${className}`}>
      <p className="text-sm italic text-gray-400 text-center">
        {message}
      </p>
    </div>
  )
}