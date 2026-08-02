interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
}

export default function LoadingSpinner({
  size = 'md',
  className = '',
}: LoadingSpinnerProps) {
  return (
    <div className={`flex items-center justify-center py-8 ${className}`}>
      <span
        className={`${SIZES[size]} border-2 border-[#E5E7EB] border-t-[#C8FF00] rounded-full animate-spin`}
      />
    </div>
  )
}