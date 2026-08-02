import { Link, useLocation } from 'react-router-dom'
import { LayoutDashboard, BarChart3, FileText, LogOut } from 'lucide-react'
import { clsx } from '../../lib/utils'

const NAV_ITEMS = [
  { label: 'Cockpit', path: '/cockpit', icon: LayoutDashboard },
  { label: 'Ops', path: '/ops', icon: BarChart3 },
  { label: 'Reports', path: '/reports', icon: FileText },
]

export default function NavBar() {
  const { pathname } = useLocation()

  function handleLogout() {
    localStorage.removeItem('pb_token')
    window.location.href = '/login'
  }

  return (
    <header className="fixed top-0 inset-x-0 z-50 bg-[#F8F7F3] border-b border-gray-200 h-14 flex items-center px-4 gap-6">
      <span className="text-[#2A004C] font-black tracking-widest text-sm mr-2 shrink-0">
        PLAYBOOK
      </span>

      <nav className="flex items-center gap-1 flex-1">
        {NAV_ITEMS.map(({ label, path, icon: Icon }) => {
          const active =
            pathname === path ||
            (path !== '/cockpit' && pathname.startsWith(path))

          return (
            <Link
              key={path}
              to={path}
              className={clsx(
                'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                active
                  ? 'bg-[#C8FF00]/20 text-[#2A004C]'
                  : 'text-gray-600 hover:text-[#2A004C] hover:bg-gray-100',
              )}
            >
              <Icon size={14} />
              {label}
            </Link>
          )
        })}
      </nav>

      <button
        onClick={handleLogout}
        className="flex items-center gap-1.5 text-gray-600 hover:text-[#2A004C] text-sm px-2 py-1.5 rounded-md hover:bg-gray-100 transition-colors"
      >
        <LogOut size={14} />
        <span className="hidden sm:inline">Sign out</span>
      </button>
    </header>
  )
}