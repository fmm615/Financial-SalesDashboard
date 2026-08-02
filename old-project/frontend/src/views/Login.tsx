import { useState, FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { login } from '../lib/api'

export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await login(email, password)
      localStorage.setItem('pb_token', res.access_token)
      navigate('/cockpit')
    } catch {
      setError('Invalid email or password.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#F8F7F3] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <p className="text-[#2A004C] font-black tracking-widest text-2xl">
            PLAYBOOK
          </p>
          <p className="text-gray-600 text-sm mt-1">
            Financial Operating System
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white border border-gray-200 shadow-sm rounded-2xl p-8 flex flex-col gap-5"
        >
          <h1 className="text-[#2A004C] font-semibold text-lg">
            Sign in
          </h1>

          {error && (
            <p className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-600">
              {error}
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-600 uppercase tracking-wider">
              Email
            </label>

            <input
              type="text"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-[#2A004C] text-sm focus:outline-none focus:border-[#2A004C] focus:ring-1 focus:ring-[#2A004C]/20 transition-colors"
              placeholder="admin@get-playbook.com"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-gray-600 uppercase tracking-wider">
              Password
            </label>

            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2.5 text-[#2A004C] text-sm focus:outline-none focus:border-[#2A004C] focus:ring-1 focus:ring-[#2A004C]/20 transition-colors"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="bg-[#2A004C] text-white font-bold py-2.5 rounded-lg text-sm hover:bg-[#3D1768] transition-colors disabled:opacity-60 disabled:cursor-not-allowed mt-1"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  )
}