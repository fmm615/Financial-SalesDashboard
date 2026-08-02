import { useState, FormEvent } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, RefreshCw, Plus } from 'lucide-react'
import {
  fetchReports,
  createReport,
  fetchReportStatus,
  type Report,
  type CreateReportPayload,
} from '../lib/api'
import LoadingSpinner from '../components/shared/LoadingSpinner'
import EmptyState from '../components/shared/EmptyState'
import { formatDate } from '../lib/utils'

function StatusBadge({ status }: { status: Report['status'] }) {
  const styles: Record<Report['status'], string> = {
    ready: 'bg-lime-900/40 text-[#C8FF00]',
    processing: 'bg-blue-900/40 text-blue-300',
    pending: 'bg-amber-900/40 text-amber-400',
    failed: 'bg-red-900/40 text-red-400',
  }
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${styles[status]}`}>
      {status}
    </span>
  )
}

function ReportRow({ report }: { report: Report }) {
  const qc = useQueryClient()

  const pollQ = useQuery({
    queryKey: ['report-status', report.id],
    queryFn: () => fetchReportStatus(report.id),
    enabled: report.status === 'processing' || report.status === 'pending',
    refetchInterval: 5000,
  })

  const current = pollQ.data ?? report

  function handlePoll() {
    void qc.invalidateQueries({ queryKey: ['report-status', report.id] })
    void qc.invalidateQueries({ queryKey: ['reports'] })
  }

  // Added new function 
    async function downloadReport(id: string, format: 'pdf' | 'zip') {
    const token = localStorage.getItem('pb_token')

    const res = await fetch(
      `/api/reports/${id}/download/${format}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    )

    if (!res.ok) {
      throw new Error('Download failed')
    }

    const blob = await res.blob()

    const url = window.URL.createObjectURL(blob)

    const a = document.createElement('a')
    a.href = url
    a.download = `report.${format}`

    document.body.appendChild(a)
    a.click()

    a.remove()
    window.URL.revokeObjectURL(url)
  }

  return (
    <tr className="hover:bg-white/5 transition-colors">
      <td className="px-4 py-3 text-[#2A004C] font-medium">{current.type}</td>
      <td className="px-4 py-3 text-gray-300">{current.period}</td>
      <td className="px-4 py-3">
        <StatusBadge status={current.status} />
      </td>
      <td className="px-4 py-3 text-gray-400 text-sm">{formatDate(current.created_at)}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {current.status === 'ready' ? (
            <>
<button
  onClick={() => downloadReport(current.id, 'pdf')}
  className="flex items-center gap-1 text-xs px-2.5 py-1 bg-[#C8FF00]/10 text-[#C8FF00] rounded-lg hover:bg-[#C8FF00]/20 transition-colors font-medium"
>
  <Download size={11} /> PDF
</button>
<button
  onClick={() => downloadReport(current.id, 'zip')}
  className="flex items-center gap-1 text-xs px-2.5 py-1 bg-white/10 text-gray-300 rounded-lg hover:bg-white/20 transition-colors font-medium"
>
  <Download size={11} /> ZIP
</button>
            </>
          ) : (current.status === 'processing' || current.status === 'pending') ? (
            <button
              onClick={handlePoll}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-[#2A004C] transition-colors"
            >
              <RefreshCw size={11} className={pollQ.isFetching ? 'animate-spin' : ''} />
              Refresh
            </button>
          ) : current.status === 'failed' ? (
            <span className="text-xs text-red-400">Generation failed.</span>
          ) : null}
        </div>
      </td>
    </tr>
  )
}

const REPORT_TYPES = ['Full Report', 'B2C Summary', 'B2B Summary', 'Financial Summary', 'Custom']

export default function ReportsView() {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<CreateReportPayload>({
    type: 'Full Report',
    date_from: '',
    date_to: '',
    label: '',
    send_email: false,
  })
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')

  const reportsQ = useQuery({ queryKey: ['reports'], queryFn: fetchReports })
  const reports = reportsQ.data ?? []

  const createMutation = useMutation({
    mutationFn: createReport,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reports'] })
      setShowForm(false)
      setFormSuccess('Report queued. It will appear in the table when ready.')
      setForm({ type: 'Full Report', date_from: '', date_to: '', label: '', send_email: false })
    },
    onError: (err: Error) => {
      setFormError(err.message || 'Failed to create report.')
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError('')
    if (!form.date_from || !form.date_to) {
      setFormError('Start and end date are required.')
      return
    }
    createMutation.mutate(form)
  }

  return (
    <div className="max-w-5xl mx-auto px-4 pt-6 pb-16 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#2A004C]">Reports</h1>
          <p className="text-sm text-gray-400 mt-0.5">Download or generate PLAYBOOK financial reports.</p>
        </div>
        <button
          onClick={() => { setShowForm(!showForm); setFormSuccess('') }}
          className="flex items-center gap-2 bg-[#C8FF00] text-[#2A004C] font-bold text-sm px-4 py-2 rounded-lg hover:bg-lime-300 transition-colors"
        >
          <Plus size={15} />
          New Report
        </button>
      </div>

      {/* Success notice */}
      {formSuccess && (
        <p className="bg-lime-900/30 border border-lime-700/40 rounded-lg px-4 py-3 text-sm text-[#C8FF00]">
          {formSuccess}
        </p>
      )}

      {/* Ad-hoc Generator Form */}
      {showForm && (
        <div className="bg-white/5 border border-white/10 rounded-xl p-6">
          <h2 className="text-base font-semibold text-[#2A004C] mb-4">Generate Ad-hoc Report</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            {formError && (
              <p className="bg-red-900/30 border border-red-700/40 rounded-lg px-3 py-2 text-sm text-red-400">
                {formError}
              </p>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Report Type
                </label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-[#2A004C] text-sm focus:outline-none focus:border-[#C8FF00]/50 focus:ring-1 focus:ring-[#C8FF00]/30"
                >
                  {REPORT_TYPES.map((t) => (
                    <option key={t} value={t} className="bg-[#F8F7F3]">{t}</option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Label
                </label>
                <input
                  type="text"
                  value={form.label}
                  onChange={(e) => setForm({ ...form, label: e.target.value })}
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-[#2A004C] text-sm focus:outline-none focus:border-[#C8FF00]/50 focus:ring-1 focus:ring-[#C8FF00]/30"
                  placeholder="e.g. Q2 2026 Review"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Date From
                </label>
                <input
                  type="date"
                  required
                  value={form.date_from}
                  onChange={(e) => setForm({ ...form, date_from: e.target.value })}
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-[#2A004C] text-sm focus:outline-none focus:border-[#C8FF00]/50 focus:ring-1 focus:ring-[#C8FF00]/30"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-400 uppercase tracking-wider">
                  Date To
                </label>
                <input
                  type="date"
                  required
                  value={form.date_to}
                  onChange={(e) => setForm({ ...form, date_to: e.target.value })}
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-[#2A004C] text-sm focus:outline-none focus:border-[#C8FF00]/50 focus:ring-1 focus:ring-[#C8FF00]/30"
                />
              </div>
            </div>

            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={form.send_email}
                onChange={(e) => setForm({ ...form, send_email: e.target.checked })}
                className="w-4 h-4 accent-[#C8FF00]"
              />
              <span className="text-sm text-gray-300">Send report to email when ready</span>
            </label>

            <div className="flex gap-3 pt-1">
              <button
                type="submit"
                disabled={createMutation.isPending}
                className="bg-[#C8FF00] text-[#2A004C] font-bold text-sm px-5 py-2 rounded-lg hover:bg-lime-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {createMutation.isPending ? 'Generating…' : 'Generate Report'}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="text-gray-400 text-sm px-4 py-2 rounded-lg hover:text-[#2A004C] hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Archive Table */}
      <section>
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
          Report Archive
        </h2>
        <div className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          {reportsQ.isLoading ? (
            <LoadingSpinner />
          ) : reports.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10">
                    {['Type', 'Period', 'Status', 'Created', 'Downloads'].map((h) => (
                      <th
                        key={h}
                        className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {reports.map((report) => (
                    <ReportRow key={report.id} report={report} />
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
