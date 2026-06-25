import { useEffect, useState } from "react"
import { Activity, FolderOpen, Pencil, Plus, Power, Server, Terminal, Trash2, X } from "lucide-react"

import { api } from "../api/client"
import { FileExplorer } from "../components/FileExplorer"
import { ConfirmDialog } from "../components/ModalDialog"
import { SshTerminal } from "../components/SshTerminal"

const emptyForm = {
  name: "",
  connection_type: "machine",
  connection_url: "",
  host: "",
  port: 22,
  username: "",
  auth_method: "none",
  password: "",
  private_key: "",
  active: true,
}

const emptyShareForm = {
  name: "",
  connection_type: "smb",
  connection_url: "",
  port: 445,
  username: "",
  auth_method: "password",
  password: "",
  active: true,
}

function formatBytes(size) {
  if (!size) return "0 B"
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function jobProgress(job) {
  if (!job.total_bytes) {
    return job.status === "completed" ? 100 : 0
  }
  return Math.min(100, Math.round((job.transferred_bytes / job.total_bytes) * 100))
}

function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`
}

function averageJobSpeed(job) {
  if (!job.started_at || !job.finished_at || !job.transferred_bytes) return 0
  const elapsedSeconds = Math.max((new Date(job.finished_at) - new Date(job.started_at)) / 1000, 1)
  return Math.round(job.transferred_bytes / elapsedSeconds)
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "calculating ETA"
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const secs = rounded % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function jobEta(job, speed) {
  if (!speed || !job.total_bytes || ["completed", "failed", "cancelled"].includes(job.status)) return ""
  const remaining = Math.max(job.total_bytes - job.transferred_bytes, 0)
  return formatDuration(remaining / speed)
}

export function DashboardPage() {
  const [devices, setDevices] = useState([])
  const [form, setForm] = useState(emptyForm)
  const [showForm, setShowForm] = useState(false)
  const [editingDevice, setEditingDevice] = useState(null)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [testingId, setTestingId] = useState(null)
  const [terminalDevice, setTerminalDevice] = useState(null)
  const [filesDevice, setFilesDevice] = useState(null)
  const [filesTargetType, setFilesTargetType] = useState("device")
  const [sharesDevice, setSharesDevice] = useState(null)
  const [shareForm, setShareForm] = useState(emptyShareForm)
  const [editingShare, setEditingShare] = useState(null)
  const [shareBusy, setShareBusy] = useState(false)
  const [fileClipboard, setFileClipboard] = useState(null)
  const [transferJobs, setTransferJobs] = useState([])
  const [cancellingJobId, setCancellingJobId] = useState(null)
  const [shareDeleteTarget, setShareDeleteTarget] = useState(null)

  async function loadDevices() {
    setDevices(await api.listDevices())
  }

  async function loadTransferJobs() {
    setTransferJobs(await api.listTransferJobs())
  }

  useEffect(() => {
    loadDevices().catch((err) => setMessage(err.message))
    loadTransferJobs().catch(() => {})
  }, [])

  useEffect(() => {
    const hasActiveJob = transferJobs.some((job) => ["pending", "running", "cancelling"].includes(job.status))
    if (!hasActiveJob) return undefined
    const timer = window.setInterval(() => {
      loadTransferJobs().catch(() => {})
    }, 2000)
    return () => window.clearInterval(timer)
  }, [transferJobs])

  const update = (event) => {
    const { name, value, type, checked } = event.target
    setForm({ ...form, [name]: type === "checkbox" ? checked : value })
  }

  const updateShare = (event) => {
    const { name, value, type, checked } = event.target
    if (name === "connection_type") {
      setShareForm({ ...shareForm, connection_type: value, port: 445, auth_method: "password", password: "" })
      return
    }
    setShareForm({ ...shareForm, [name]: type === "checkbox" ? checked : value })
  }

  function startCreate() {
    setEditingDevice(null)
    setForm(emptyForm)
    setShowForm((value) => !value)
    setMessage("")
  }

  function startEdit(device) {
    setEditingDevice(device)
    setForm({
      name: device.name,
      connection_type: device.connection_type,
      connection_url: device.connection_url ?? "",
      host: device.host,
      port: device.port,
      username: device.username,
      auth_method: device.auth_method,
      password: "",
      private_key: "",
      active: device.active,
    })
    setShowForm(true)
    setMessage("Secrets are not shown after saving. Enter a new password or SSH key only if you want to replace it.")
  }

  function cancelForm() {
    setEditingDevice(null)
    setForm(emptyForm)
    setShowForm(false)
  }

  function validateMachineForm() {
    if (!form.name.trim()) return "Friendly name is required."
    if (!form.host.trim()) return "Host/IP is required."
    if (form.connection_type === "ssh_sftp") {
      const port = Number(form.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return "SSH port must be between 1 and 65535."
      if (!form.username.trim()) return "SSH user is required."
      if (form.auth_method === "password" && !editingDevice && !form.password) return "Password is required."
      if (form.auth_method === "ssh_key" && !editingDevice && !form.private_key.trim()) return "Private key is required."
    }
    return ""
  }

  async function submit(event) {
    event.preventDefault()
    const validationError = validateMachineForm()
    if (validationError) {
      setMessage(validationError)
      return
    }
    setBusy(true)
    setMessage("")
    try {
      const basePayload = {
        ...form,
        port: Number(form.port),
      }
      if (editingDevice) {
        const payload = {
          name: basePayload.name,
          host: basePayload.host,
          connection_url: basePayload.connection_url,
          port: basePayload.port,
          username: basePayload.username,
          auth_method: basePayload.auth_method,
          active: basePayload.active,
        }
        if (basePayload.auth_method === "password" && basePayload.password) {
          payload.password = basePayload.password
        }
        if (basePayload.auth_method === "ssh_key" && basePayload.private_key) {
          payload.private_key = basePayload.private_key
        }
        await api.updateDevice(editingDevice.id, payload)
        setMessage("Device updated.")
      } else {
        const payload = {
          ...basePayload,
          password: basePayload.auth_method === "password" ? basePayload.password : null,
          private_key: basePayload.auth_method === "ssh_key" ? basePayload.private_key : null,
        }
        await api.createDevice(payload)
        setMessage("Device added.")
      }
      setForm(emptyForm)
      setEditingDevice(null)
      setShowForm(false)
      await loadDevices()
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function testDevice(device) {
    setTestingId(device.id)
    setMessage("")
    try {
      const result = await api.testDevice(device.id)
      setMessage(result.status)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setTestingId(null)
    }
  }

  async function removeDevice(device) {
    setMessage("")
    await api.deleteDevice(device.id)
    if (terminalDevice?.id === device.id) {
      setTerminalDevice(null)
    }
    if (filesDevice?.id === device.id) {
      setFilesDevice(null)
    }
    await loadDevices()
    setMessage("Device removed.")
  }

  function openTerminal(device) {
    setFilesDevice(null)
    setSharesDevice(null)
    setTerminalDevice(device)
  }

  function openFiles(device) {
    setTerminalDevice(null)
    setSharesDevice(null)
    setFilesTargetType("device")
    setFilesDevice(device)
  }

  function openShareFiles(share) {
    setTerminalDevice(null)
    setSharesDevice(null)
    setFilesTargetType("share")
    setFilesDevice(share)
  }

  function openShares(device) {
    setTerminalDevice(null)
    setFilesDevice(null)
    setSharesDevice(device)
    setShareForm(emptyShareForm)
    setEditingShare(null)
  }

  function closeWorkspace() {
    setTerminalDevice(null)
    setFilesDevice(null)
    setSharesDevice(null)
    setEditingShare(null)
    setShareForm(emptyShareForm)
  }

  function handleTransferJobCreated(job) {
    setTransferJobs((current) => [job, ...current.filter((item) => item.id !== job.id)].slice(0, 20))
  }

  async function cancelTransferJob(job) {
    setCancellingJobId(job.id)
    try {
      const updated = await api.cancelTransferJob(job.id)
      setTransferJobs((current) => current.map((item) => item.id === updated.id ? updated : item))
    } catch (err) {
      setMessage(err.message)
    } finally {
      setCancellingJobId(null)
    }
  }

  async function dismissTransferJob(job) {
    try {
      await api.dismissTransferJob(job.id)
      setTransferJobs((current) => current.filter((item) => item.id !== job.id))
    } catch (err) {
      setMessage(err.message)
    }
  }

  function startEditShare(share) {
    setEditingShare(share)
    setShareForm({
      name: share.name,
      connection_type: share.connection_type,
      connection_url: share.connection_url,
      port: share.port,
      username: share.username ?? "",
      auth_method: share.auth_method ?? (share.connection_type === "smb" ? "password" : "none"),
      password: "",
      active: share.active,
    })
    setMessage("Share secrets are not shown after saving. Enter a new password only if you want to replace it.")
  }

  function cancelShareEdit() {
    setEditingShare(null)
    setShareForm(emptyShareForm)
    setMessage("")
  }

  function validateShareForm() {
    if (!shareForm.name.trim()) return "Share name is required."
    if (!shareForm.connection_url.trim()) return "Share path is required."
    const port = Number(shareForm.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "Share port must be between 1 and 65535."
    if (shareForm.auth_method === "password" && !editingShare && !shareForm.password) return "Share password is required."
    return ""
  }

  async function saveShare(event) {
    event.preventDefault()
    if (!sharesDevice) return
    const validationError = validateShareForm()
    if (validationError) {
      setMessage(validationError)
      return
    }
    setShareBusy(true)
    setMessage("")
    try {
      const payload = {
        ...shareForm,
        port: Number(shareForm.port),
        password: shareForm.auth_method === "password" && shareForm.password ? shareForm.password : null,
      }
      if (editingShare) {
        await api.updateShare(editingShare.id, payload)
      } else {
        await api.createShare(sharesDevice.id, payload)
      }
      setShareForm(emptyShareForm)
      setEditingShare(null)
      await loadDevices()
      const shares = await api.listShares(sharesDevice.id)
      setSharesDevice((current) => current ? { ...current, shares } : current)
      setMessage(editingShare ? "Share updated." : "Share added.")
    } catch (err) {
      setMessage(err.message)
    } finally {
      setShareBusy(false)
    }
  }

  async function removeShare(share) {
    setShareDeleteTarget(share)
  }

  async function removeShareConfirmed() {
    if (!shareDeleteTarget) return
    try {
      await api.deleteShare(shareDeleteTarget.id)
      await loadDevices()
      if (sharesDevice) {
        setSharesDevice({ ...sharesDevice, shares: await api.listShares(sharesDevice.id) })
      }
      setShareDeleteTarget(null)
    } catch (err) {
      setMessage(err.message)
    }
  }

  async function testShare(share) {
    try {
      const result = await api.testShare(share.id)
      setMessage(result.status)
    } catch (err) {
      setMessage(err.message)
    }
  }

  function TransferJobsPanel() {
    if (transferJobs.length === 0) return null
    return (
      <section className="rounded-lg border border-line bg-panel p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="shrink-0 text-teal-300" size={18} aria-hidden="true" />
            <h3 className="truncate text-sm font-semibold text-ink">Transfers</h3>
          </div>
          <button className="btn-secondary min-h-9 px-3" onClick={loadTransferJobs}>Refresh</button>
        </div>
        <div className="space-y-3">
          {transferJobs.slice(0, 5).map((job) => {
            const progress = jobProgress(job)
            const verb = job.action === "move" ? "Move" : "Copy"
            const speed = job.status === "completed" ? averageJobSpeed(job) : job.speed_bytes_per_second
            const eta = jobEta(job, speed)
            const canCancel = ["pending", "running", "cancelling"].includes(job.status)
            const canDismiss = ["completed", "failed", "cancelled"].includes(job.status)
            return (
              <article key={job.id} className="rounded-md border border-line bg-surface p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">
                      {verb} {job.source_paths.length} item{job.source_paths.length === 1 ? "" : "s"} from {job.source_device_name} to {job.destination_device_name}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted">
                      {job.status === "failed" || job.status === "cancelled"
                        ? job.error
                        : `${formatBytes(job.transferred_bytes)} / ${formatBytes(job.total_bytes)} · ${speed ? formatSpeed(speed) : "measuring speed"}${eta ? ` · ETA ${eta}` : ""} · ${job.copied_files || 0}/${job.total_files || 0} files`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${job.status === "completed" ? "bg-teal-950 text-teal-200" : job.status === "failed" || job.status === "cancelled" ? "bg-red-950 text-red-100" : "bg-slate-800 text-slate-200"}`}>
                      {job.status}
                    </span>
                    {canCancel && (
                      <button className="btn-danger min-h-9 px-3 text-xs" onClick={() => cancelTransferJob(job)} disabled={cancellingJobId === job.id || job.status === "cancelling"}>
                        {job.status === "cancelling" || cancellingJobId === job.id ? "Cancelling" : "Cancel"}
                      </button>
                    )}
                    {canDismiss && (
                      <button className="btn-secondary min-h-9 px-2" onClick={() => dismissTransferJob(job)} title="Hide transfer">
                        <X size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
                  <div className={`h-full rounded-full ${job.status === "failed" || job.status === "cancelled" ? "bg-red-500" : job.status === "cancelling" ? "bg-amber-400" : "bg-teal-400"}`} style={{ width: `${progress}%` }} />
                </div>
              </article>
            )
          })}
        </div>
      </section>
    )
  }

  function renderSharesPanel() {
    const device = sharesDevice
    if (!device) return null
    const shares = device.shares ?? []
    return (
      <section className="rounded-lg border border-line bg-panel">
        <header className="flex flex-col gap-3 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{device.name} shares</h3>
            <p className="truncate text-xs text-muted">{device.host}</p>
          </div>
          <button className="btn-secondary px-3" onClick={closeWorkspace}>
            <X size={17} aria-hidden="true" />
            Close
          </button>
        </header>
        <div className="space-y-4 p-4">
          <form className="grid gap-3 rounded-md border border-line bg-surface p-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={saveShare} noValidate>
            <div>
              <label className="label" htmlFor="share-name">Name</label>
              <input className="field mt-1" id="share-name" name="name" value={shareForm.name} onChange={updateShare} required />
            </div>
            <div>
              <label className="label" htmlFor="share-type">Type</label>
              <select className="field mt-1" id="share-type" name="connection_type" value={shareForm.connection_type} onChange={updateShare}>
                <option value="smb">SMB</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="share-path">Share path</label>
              <input className="field mt-1" id="share-path" name="connection_url" value={shareForm.connection_url} onChange={updateShare} placeholder={`smb://${device.host}/Share`} required />
            </div>
            <div>
              <label className="label" htmlFor="share-port">Port</label>
              <input className="field mt-1" id="share-port" name="port" type="number" min="1" max="65535" value={shareForm.port} onChange={updateShare} required />
            </div>
            {shareForm.connection_type === "smb" && (
              <>
                <div>
                  <label className="label" htmlFor="share-user">User</label>
                  <input className="field mt-1" id="share-user" name="username" value={shareForm.username} onChange={updateShare} />
                </div>
                <div>
                  <label className="label" htmlFor="share-password">Password</label>
                  <input className="field mt-1" id="share-password" name="password" type="password" value={shareForm.password} onChange={updateShare} required={shareForm.auth_method === "password" && !editingShare} placeholder={editingShare ? "Leave blank to keep current password" : ""} />
                </div>
              </>
            )}
            <div className="flex items-end gap-3 md:col-span-2 xl:col-span-3">
              <button className="btn-primary" disabled={shareBusy}>{shareBusy ? "Saving..." : editingShare ? "Save share" : "Add share"}</button>
              {editingShare && (
                <button type="button" className="btn-secondary" onClick={cancelShareEdit}>Cancel</button>
              )}
            </div>
          </form>

          <div className="space-y-3">
            {shares.map((share) => (
              <article key={share.id} className="flex flex-col gap-3 rounded-md border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h4 className="truncate text-sm font-semibold text-ink">{share.name}</h4>
                  <p className="truncate text-xs text-muted">{share.connection_url}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary min-h-9 px-3" onClick={() => testShare(share)}>Test</button>
                  <button className="btn-secondary min-h-9 px-3" onClick={() => openShareFiles(share)} disabled={share.connection_type !== "smb"}>Files</button>
                  <button className="btn-secondary min-h-9 px-3" onClick={() => startEditShare(share)}>
                    <Pencil size={15} aria-hidden="true" />
                    Edit
                  </button>
                  <button className="btn-danger min-h-9 px-3" onClick={() => removeShare(share)}>
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                </div>
              </article>
            ))}
            {shares.length === 0 && <p className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-muted">No shares added for this machine.</p>}
          </div>
        </div>
      </section>
    )
  }

  function DeviceActions({ device, compact = false }) {
    return (
      <div className={compact ? "grid grid-cols-2 gap-2" : "mt-4 grid grid-cols-2 gap-2"}>
        <button className="btn-secondary px-3" onClick={() => openShares(device)}>
          <FolderOpen size={17} aria-hidden="true" />
          Shares
        </button>
        <button className="btn-secondary px-3" onClick={() => openTerminal(device)} disabled={device.connection_type !== "ssh_sftp"}>
          <Terminal size={17} aria-hidden="true" />
          Terminal
        </button>
        <button className="btn-secondary px-3" onClick={() => openFiles(device)} disabled={!["ssh_sftp", "smb"].includes(device.connection_type)} title={["ssh_sftp", "smb"].includes(device.connection_type) ? "Open files" : "Enable SSH/SFTP or add a share to browse files"}>
          <FolderOpen size={17} aria-hidden="true" />
          Files
        </button>
        <button className="btn-secondary px-3" onClick={() => startEdit(device)}>
          <Pencil size={17} aria-hidden="true" />
          Edit
        </button>
        <button className="btn-danger col-span-2 px-3" onClick={() => removeDevice(device)}>
          <Trash2 size={17} aria-hidden="true" />
          Delete
        </button>
      </div>
    )
  }

  function DeviceSummary({ device }) {
    const activeWorkspace = terminalDevice?.id === device.id || (filesTargetType === "device" && filesDevice?.id === device.id) || sharesDevice?.id === device.id
    return (
      <article className={`rounded-lg border p-3 ${activeWorkspace ? "border-signal bg-surface" : "border-line bg-panel"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{device.name}</h3>
            <p className="truncate text-xs text-muted">{device.host}{device.connection_type === "ssh_sftp" ? `:${device.port}` : ""} · {(device.shares ?? []).length} share{(device.shares ?? []).length === 1 ? "" : "s"}</p>
          </div>
          <span className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold ${device.active ? "bg-teal-950 text-teal-200" : "bg-slate-800 text-slate-300"}`}>
            <Power size={13} aria-hidden="true" />
            {device.active ? "Active" : "Inactive"}
          </span>
        </div>
        <DeviceActions device={device} />
      </article>
    )
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-ink sm:text-3xl">Devices</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">Add machines, optional SSH/SFTP access, and multiple SMB shares per machine.</p>
        </div>
        <button className="btn-primary w-full sm:w-auto" onClick={startCreate}>
          <Plus size={18} aria-hidden="true" />
          Add machine
        </button>
      </section>

      {message && <p className="rounded-md border border-line bg-panel px-4 py-3 text-sm text-ink">{message}</p>}

      <TransferJobsPanel />

      {showForm && (
        <section className="rounded-lg border border-line bg-panel p-4 sm:p-5">
          <h3 className="mb-4 text-lg font-semibold text-ink">{editingDevice ? "Edit machine" : "New machine"}</h3>
          <form className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" onSubmit={submit} noValidate>
            <div>
              <label className="label" htmlFor="name">Friendly name</label>
              <input className="field mt-1" id="name" name="name" value={form.name} onChange={update} required />
            </div>
            <div>
              <label className="label" htmlFor="host">Host/IP</label>
              <input className="field mt-1" id="host" name="host" value={form.host} onChange={update} required />
            </div>
            <label className="flex min-h-11 items-end gap-3 text-sm text-ink">
              <input
                className="mb-3 h-5 w-5 rounded border-line bg-surface accent-teal-400"
                type="checkbox"
                checked={form.connection_type === "ssh_sftp"}
                onChange={(event) => setForm({ ...form, connection_type: event.target.checked ? "ssh_sftp" : "machine", auth_method: event.target.checked ? "password" : "none", username: event.target.checked ? form.username : "", password: "", private_key: "" })}
              />
              Enable SSH/SFTP
            </label>
            {form.connection_type === "ssh_sftp" && (
              <>
                <div>
                  <label className="label" htmlFor="port">SSH port</label>
                  <input className="field mt-1" id="port" name="port" type="number" min="1" max="65535" value={form.port} onChange={update} required />
                </div>
                <div>
                  <label className="label" htmlFor="username">SSH user</label>
                  <input className="field mt-1" id="username" name="username" value={form.username} onChange={update} required />
                </div>
                <div>
                  <label className="label" htmlFor="auth_method">SSH auth</label>
                  <select className="field mt-1" id="auth_method" name="auth_method" value={form.auth_method} onChange={update}>
                    <option value="password">Password</option>
                    <option value="ssh_key">SSH key</option>
                  </select>
                </div>
              </>
            )}
            {form.connection_type === "ssh_sftp" && form.auth_method === "password" ? (
              <div className="md:col-span-2 xl:col-span-3">
                <label className="label" htmlFor="password">Password</label>
                <input className="field mt-1" id="password" name="password" type="password" value={form.password} onChange={update} autoComplete="new-password" required={!editingDevice} placeholder={editingDevice ? "Leave blank to keep current password" : ""} />
              </div>
            ) : form.connection_type === "ssh_sftp" && form.auth_method === "ssh_key" ? (
              <div className="md:col-span-2 xl:col-span-3">
                <label className="label" htmlFor="private_key">Private key</label>
                <textarea className="field mt-1 min-h-36" id="private_key" name="private_key" value={form.private_key} onChange={update} required={!editingDevice} placeholder={editingDevice ? "Leave blank to keep current SSH key" : ""} />
              </div>
            ) : null}
            <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
              <input className="h-5 w-5 rounded border-line bg-surface accent-teal-400" type="checkbox" name="active" checked={form.active} onChange={update} />
              Active
            </label>
            <div className="flex flex-col gap-3 sm:flex-row md:col-span-2 xl:col-span-3">
              <button className="btn-primary" disabled={busy}>{busy ? "Saving..." : editingDevice ? "Save changes" : "Save machine"}</button>
              <button type="button" className="btn-secondary" onClick={cancelForm}>Cancel</button>
            </div>
          </form>
        </section>
      )}

      {devices.length === 0 ? (
        <section className="grid min-h-64 place-items-center rounded-lg border border-dashed border-line bg-panel/60 p-6 text-center">
          <div>
            <Server className="mx-auto mb-3 text-muted" size={40} aria-hidden="true" />
            <h3 className="text-lg font-semibold text-ink">No machines configured</h3>
            <p className="mt-1 text-sm text-muted">First launch starts empty. Add your first machine when ready.</p>
          </div>
        </section>
      ) : (
        <section className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1.35fr)]">
          <aside className="space-y-3 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-auto">
            {devices.map((device) => (
              <DeviceSummary key={device.id} device={device} />
            ))}
          </aside>

          <div className="min-w-0">
            {terminalDevice ? (
              <SshTerminal device={terminalDevice} onClose={closeWorkspace} embedded />
            ) : filesDevice ? (
              <FileExplorer
                device={filesDevice}
                targetType={filesTargetType}
                onClose={closeWorkspace}
                clipboard={fileClipboard}
                onClipboardSet={setFileClipboard}
                onClipboardClear={() => setFileClipboard(null)}
                onJobCreated={handleTransferJobCreated}
                embedded
              />
            ) : sharesDevice ? (
              renderSharesPanel()
            ) : (
              <section className="grid min-h-[620px] place-items-center rounded-lg border border-line bg-panel/60 p-6 text-center">
                <div>
                  <Server className="mx-auto mb-3 text-muted" size={42} aria-hidden="true" />
                  <h3 className="text-lg font-semibold text-ink">Choose a machine action</h3>
                  <p className="mt-1 max-w-md text-sm text-muted">Open Files or Terminal from the sidebar and keep your device list visible while you work.</p>
                </div>
              </section>
            )}
          </div>
        </section>
      )}
      {shareDeleteTarget && (
        <ConfirmDialog
          title="Delete share"
          message={`Delete share ${shareDeleteTarget.name}?`}
          confirmLabel="Delete"
          danger
          onConfirm={removeShareConfirmed}
          onCancel={() => setShareDeleteTarget(null)}
        />
      )}
    </div>
  )
}
