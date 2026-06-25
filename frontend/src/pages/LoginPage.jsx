import { useState } from "react"

import { api } from "../api/client"
import { AuthLayout } from "../components/AuthLayout"

export function LoginPage({ onReady }) {
  const [form, setForm] = useState({ identifier: "", password: "" })
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)

  const update = (event) => setForm({ ...form, [event.target.name]: event.target.value })

  async function submit(event) {
    event.preventDefault()
    const identifier = form.identifier.trim()
    if (!identifier) {
      setError("Email or name is required.")
      return
    }
    if (!form.password) {
      setError("Password is required.")
      return
    }
    setBusy(true)
    setError("")
    try {
      const user = await api.login({ ...form, identifier })
      onReady(user)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout subtitle="Sign in to manage your homelab">
      <form className="space-y-4" onSubmit={submit} noValidate>
        <div>
          <label className="label" htmlFor="identifier">Email or name</label>
          <input className="field mt-1" id="identifier" name="identifier" value={form.identifier} onChange={update} autoComplete="username" required />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input className="field mt-1" id="password" name="password" type="password" value={form.password} onChange={update} autoComplete="current-password" required />
        </div>
        {error && <p className="text-sm text-red-300">{error}</p>}
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Signing in..." : "Login"}</button>
      </form>
    </AuthLayout>
  )
}
