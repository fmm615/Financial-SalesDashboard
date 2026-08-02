import { useState } from 'react'
import B2CTab from './B2CTab'
import B2BTab from './B2BTab'
import FinancialTab from './FinancialTab'
import { clsx } from '../../lib/utils'

type Tab = 'b2c' | 'b2b' | 'financial'

const TABS: { id: Tab; label: string }[] = [
  { id: 'b2c', label: 'B2C' },
  { id: 'b2b', label: 'B2B' },
  { id: 'financial', label: 'Financial' },
]

export default function OperationalDashboard() {
  const [tab, setTab] = useState<Tab>('b2c')

  return (
    <div className="max-w-5xl mx-auto px-4 pt-6 pb-16">
      {/* Tab switcher */}
      <div className="flex gap-1 border-b border-white/10 mb-8">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx(
              'px-5 py-2.5 text-sm font-semibold border-b-2 -mb-px transition-colors',
              tab === id
                ? 'border-[#C8FF00] text-[#C8FF00]'
                : 'border-transparent text-gray-400 hover:text-[#2A004C] hover:border-white/30',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'b2c' && <B2CTab />}
      {tab === 'b2b' && <B2BTab />}
      {tab === 'financial' && <FinancialTab />}
    </div>
  )
}
