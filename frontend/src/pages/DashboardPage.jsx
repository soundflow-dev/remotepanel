import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Activity, BarChart3, FolderOpen, Pencil, Plus, Power, PowerOff, RotateCcw, Server, Terminal, Trash2, X, Zap } from "lucide-react"

import { api } from "../api/client"
import { FileExplorer } from "../components/FileExplorer"
import { ConfirmDialog } from "../components/ModalDialog"
import { SshTerminal } from "../components/SshTerminal"
import { plural, useI18n } from "../i18n"

const emptyForm = {
  name: "",
  connection_type: "machine",
  connection_url: "",
  host: "",
  mac_address: "",
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
  if (!Number.isFinite(seconds) || seconds <= 0) return null
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

function percent(used, total) {
  if (!used || !total) return 0
  return Math.min(100, Math.round((used / total) * 100))
}

function roundedPercent(value) {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

export function DashboardPage() {
  const { t } = useI18n()
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
  const [statsDevice, setStatsDevice] = useState(null)
  const [statsData, setStatsData] = useState(null)
  const [statsLoading, setStatsLoading] = useState(false)
  const [shareForm, setShareForm] = useState(emptyShareForm)
  const [showShareForm, setShowShareForm] = useState(false)
  const [editingShare, setEditingShare] = useState(null)
  const [shareBusy, setShareBusy] = useState(false)
  const [fileClipboard, setFileClipboard] = useState(null)
  const [transferJobs, setTransferJobs] = useState([])
  const [cancellingJobId, setCancellingJobId] = useState(null)
  const [shareDeleteTarget, setShareDeleteTarget] = useState(null)
  const [deviceDeleteTarget, setDeviceDeleteTarget] = useState(null)
  const [deviceActionTarget, setDeviceActionTarget] = useState(null)
  const [powerMenuDeviceId, setPowerMenuDeviceId] = useState(null)
  const deviceListRef = useRef(null)
  const deviceListScrollTopRef = useRef(0)
  const powerMenuRef = useRef(null)

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

  useLayoutEffect(() => {
    if (deviceListRef.current) {
      deviceListRef.current.scrollTop = deviceListScrollTopRef.current
    }
  }, [terminalDevice?.id, filesDevice?.id, filesTargetType, sharesDevice?.id, statsDevice?.id, devices.length])

  useEffect(() => {
    const hasActiveJob = transferJobs.some((job) => ["pending", "running", "cancelling"].includes(job.status))
    if (!hasActiveJob) return undefined
    const timer = window.setInterval(() => {
      loadTransferJobs().catch(() => {})
    }, 2000)
    return () => window.clearInterval(timer)
  }, [transferJobs])

  useEffect(() => {
    if (!powerMenuDeviceId) return undefined

    function closeOnOutsideClick(event) {
      if (powerMenuRef.current?.contains(event.target)) return
      setPowerMenuDeviceId(null)
    }

    function closeOnEscape(event) {
      if (event.key === "Escape") {
        setPowerMenuDeviceId(null)
      }
    }

    document.addEventListener("mousedown", closeOnOutsideClick)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [powerMenuDeviceId])

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
      mac_address: device.mac_address ?? "",
      port: device.port,
      username: device.username,
      auth_method: device.auth_method,
      password: "",
      private_key: "",
      active: device.active,
    })
    setShowForm(true)
    setMessage(t("dashboard.secretsHidden"))
  }

  function cancelForm() {
    setEditingDevice(null)
    setForm(emptyForm)
    setShowForm(false)
  }

  function validateMachineForm() {
    if (!form.name.trim()) return t("dashboard.nameRequired")
    if (!form.host.trim()) return t("dashboard.hostRequired")
    if (form.connection_type === "ssh_sftp") {
      const port = Number(form.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return t("dashboard.sshPortInvalid")
      if (!form.username.trim()) return t("dashboard.sshUserRequired")
      if (form.auth_method === "password" && !editingDevice && !form.password) return t("dashboard.passwordRequired")
      if (form.auth_method === "ssh_key" && !editingDevice && !form.private_key.trim()) return t("dashboard.privateKeyRequired")
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
          mac_address: basePayload.mac_address || null,
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
        setMessage(t("dashboard.deviceUpdated"))
      } else {
        const payload = {
          ...basePayload,
          password: basePayload.auth_method === "password" ? basePayload.password : null,
          private_key: basePayload.auth_method === "ssh_key" ? basePayload.private_key : null,
        }
        await api.createDevice(payload)
        setMessage(t("dashboard.deviceAdded"))
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
    setDeviceDeleteTarget(device)
  }

  async function removeDeviceConfirmed() {
    if (!deviceDeleteTarget) return
    setMessage("")
    try {
      await api.deleteDevice(deviceDeleteTarget.id)
      if (terminalDevice?.id === deviceDeleteTarget.id) {
        setTerminalDevice(null)
      }
      if (filesDevice?.id === deviceDeleteTarget.id) {
        setFilesDevice(null)
      }
      if (sharesDevice?.id === deviceDeleteTarget.id) {
        setSharesDevice(null)
      }
      if (statsDevice?.id === deviceDeleteTarget.id) {
        setStatsDevice(null)
        setStatsData(null)
      }
      setDeviceDeleteTarget(null)
      setEditingDevice(null)
      setShowForm(false)
      await loadDevices()
      setMessage(t("dashboard.deviceRemoved"))
    } catch (err) {
      setMessage(err.message)
    }
  }

  function requestDeviceAction(device, action) {
    setPowerMenuDeviceId(null)
    setDeviceActionTarget({ device, action })
  }

  async function runDeviceActionConfirmed() {
    if (!deviceActionTarget) return
    const { device, action } = deviceActionTarget
    setMessage("")
    try {
      const result = await api.runDeviceAction(device.id, action)
      setMessage(result.status)
      setDeviceActionTarget(null)
    } catch (err) {
      setMessage(err.message)
    }
  }

  function openTerminal(device) {
    captureDeviceListScroll()
    setFilesDevice(null)
    setSharesDevice(null)
    setStatsDevice(null)
    setTerminalDevice(device)
  }

  function openFiles(device) {
    captureDeviceListScroll()
    setTerminalDevice(null)
    setSharesDevice(null)
    setStatsDevice(null)
    setFilesTargetType("device")
    setFilesDevice(device)
  }

  function openShareFiles(share) {
    captureDeviceListScroll()
    setTerminalDevice(null)
    setSharesDevice(null)
    setStatsDevice(null)
    setFilesTargetType("share")
    setFilesDevice(share)
  }

  function openShares(device) {
    captureDeviceListScroll()
    setTerminalDevice(null)
    setFilesDevice(null)
    setStatsDevice(null)
    setSharesDevice(device)
    setShareForm(emptyShareForm)
    setShowShareForm(false)
    setEditingShare(null)
  }

  function closeWorkspace() {
    captureDeviceListScroll()
    setTerminalDevice(null)
    setFilesDevice(null)
    setSharesDevice(null)
    setStatsDevice(null)
    setStatsData(null)
    setShowShareForm(false)
    setEditingShare(null)
    setShareForm(emptyShareForm)
  }

  async function openStats(device) {
    captureDeviceListScroll()
    setTerminalDevice(null)
    setFilesDevice(null)
    setSharesDevice(null)
    setStatsDevice(device)
    setStatsData(null)
    setStatsLoading(true)
    setMessage("")
    try {
      setStatsData(await api.getDeviceStats(device.id))
    } catch (err) {
      setMessage(err.message)
    } finally {
      setStatsLoading(false)
    }
  }

  function captureDeviceListScroll() {
    if (deviceListRef.current) {
      deviceListScrollTopRef.current = deviceListRef.current.scrollTop
    }
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

  function startCreateShare() {
    setEditingShare(null)
    setShareForm(emptyShareForm)
    setShowShareForm(true)
    setMessage("")
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
    setShowShareForm(true)
    setMessage(t("shares.secretsHidden"))
  }

  function cancelShareEdit() {
    setEditingShare(null)
    setShareForm(emptyShareForm)
    setShowShareForm(false)
    setMessage("")
  }

  function validateShareForm() {
    if (!shareForm.name.trim()) return t("shares.nameRequired")
    if (!shareForm.connection_url.trim()) return t("shares.pathRequired")
    const port = Number(shareForm.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return t("shares.portInvalid")
    if (shareForm.auth_method === "password" && !editingShare && !shareForm.password) return t("shares.passwordRequired")
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
      setShowShareForm(false)
      await loadDevices()
      const shares = await api.listShares(sharesDevice.id)
      setSharesDevice((current) => current ? { ...current, shares } : current)
      setMessage(editingShare ? t("shares.updated") : t("shares.added"))
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
      if (editingShare?.id === shareDeleteTarget.id) {
        setEditingShare(null)
        setShareForm(emptyShareForm)
        setShowShareForm(false)
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
      <section className="rounded-md border border-line bg-panel p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="shrink-0 text-signal" size={18} aria-hidden="true" />
            <h3 className="truncate text-sm font-semibold text-ink">{t("transfers.title")}</h3>
          </div>
          <button className="btn-secondary min-h-9 px-3" onClick={loadTransferJobs}>{t("common.refresh")}</button>
        </div>
        <div className="space-y-2">
          {transferJobs.slice(0, 5).map((job) => {
            const progress = jobProgress(job)
            const verb = job.action === "move" ? t("common.move") : t("common.copy")
            const speed = job.status === "completed" ? averageJobSpeed(job) : job.speed_bytes_per_second
            const eta = jobEta(job, speed)
            const canCancel = ["pending", "running", "cancelling"].includes(job.status)
            const canDismiss = ["completed", "failed", "cancelled"].includes(job.status)
            const itemPlural = plural(job.source_paths.length)
            return (
              <article key={job.id} className="rounded border border-line bg-panel p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">
                      {t("transfers.jobTitle", { verb, count: job.source_paths.length, plural: itemPlural, source: job.source_device_name, destination: job.destination_device_name })}
                    </p>
                    <p className="mt-1 truncate text-xs text-muted">
                      {job.status === "failed" || job.status === "cancelled"
                        ? job.error
                        : `${formatBytes(job.transferred_bytes)} / ${formatBytes(job.total_bytes)} · ${speed ? formatSpeed(speed) : t("transfers.measuringSpeed")}${eta ? ` · ${t("transfers.eta", { value: eta })}` : ""} · ${t("transfers.files", { copied: job.copied_files || 0, total: job.total_files || 0 })}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className={`rounded px-2 py-1 text-xs font-semibold ${job.status === "completed" ? "bg-signal/15 text-signal" : job.status === "failed" || job.status === "cancelled" ? "bg-red-500/10 text-red-600" : "bg-surface text-muted"}`}>
                      {t(`transfers.status.${job.status}`)}
                    </span>
                    {canCancel && (
                      <button className="btn-danger min-h-9 px-3 text-xs" onClick={() => cancelTransferJob(job)} disabled={cancellingJobId === job.id || job.status === "cancelling"}>
                        {job.status === "cancelling" || cancellingJobId === job.id ? t("transfers.cancelling") : t("common.cancel")}
                      </button>
                    )}
                    {canDismiss && (
                      <button className="btn-secondary min-h-9 px-2" onClick={() => dismissTransferJob(job)} title={t("transfers.hide")}>
                        <X size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-line/60">
                  <div className={`h-full rounded-full ${job.status === "failed" || job.status === "cancelled" ? "bg-red-500" : job.status === "cancelling" ? "bg-amber-400" : "bg-signal"}`} style={{ width: `${progress}%` }} />
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
      <section className="rounded-md border border-line bg-panel">
        <header className="flex flex-col gap-3 border-b border-line px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{t("shares.title", { name: device.name })}</h3>
            <p className="truncate text-xs text-muted">{device.host}</p>
          </div>
          <button className="btn-secondary px-3" onClick={closeWorkspace}>
            <X size={17} aria-hidden="true" />
            {t("common.close")}
          </button>
        </header>
        <div className="space-y-2 p-3">
          {!showShareForm && (
            <div className="flex justify-end">
              <button className="btn-primary" type="button" onClick={startCreateShare}>
                <Plus size={17} aria-hidden="true" />
                {t("shares.add")}
              </button>
            </div>
          )}

          {showShareForm && (
            <form className="grid gap-3 rounded border border-line bg-surface p-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={saveShare} noValidate>
              <div>
                <label className="label" htmlFor="share-name">{t("common.name")}</label>
                <input className="field mt-1" id="share-name" name="name" value={shareForm.name} onChange={updateShare} required />
              </div>
              <div>
                <label className="label" htmlFor="share-type">{t("common.type")}</label>
                <select className="field mt-1" id="share-type" name="connection_type" value={shareForm.connection_type} onChange={updateShare}>
                  <option value="smb">SMB</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="share-path">{t("shares.path")}</label>
                <input className="field mt-1" id="share-path" name="connection_url" value={shareForm.connection_url} onChange={updateShare} placeholder={`smb://${device.host}/Share`} required />
              </div>
              <div>
                <label className="label" htmlFor="share-port">{t("common.port")}</label>
                <input className="field mt-1" id="share-port" name="port" type="number" min="1" max="65535" value={shareForm.port} onChange={updateShare} required />
              </div>
              {shareForm.connection_type === "smb" && (
                <>
                  <div>
                    <label className="label" htmlFor="share-user">{t("common.user")}</label>
                    <input className="field mt-1" id="share-user" name="username" value={shareForm.username} onChange={updateShare} />
                  </div>
                  <div>
                    <label className="label" htmlFor="share-password">{t("common.password")}</label>
                    <input className="field mt-1" id="share-password" name="password" type="password" value={shareForm.password} onChange={updateShare} required={shareForm.auth_method === "password" && !editingShare} placeholder={editingShare ? t("dashboard.leavePassword") : ""} />
                  </div>
                </>
              )}
              <div className="flex items-end gap-3 md:col-span-2 xl:col-span-3">
                <button className="btn-primary" disabled={shareBusy}>{shareBusy ? t("common.saving") : editingShare ? t("shares.save") : t("shares.add")}</button>
                <button type="button" className="btn-secondary" onClick={cancelShareEdit}>{t("common.cancel")}</button>
                {editingShare && (
                  <button type="button" className="btn-danger md:ml-auto" onClick={() => removeShare(editingShare)}>
                    <Trash2 size={17} aria-hidden="true" />
                    {t("shares.deleteShare")}
                  </button>
                )}
              </div>
            </form>
          )}

          <div className="space-y-2">
            {shares.map((share) => (
              <article key={share.id} className="flex flex-col gap-3 rounded border border-line bg-panel px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h4 className="truncate text-sm font-semibold text-ink">{share.name}</h4>
                  <p className="truncate text-xs text-muted">{share.connection_url}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary min-h-8 px-3 text-xs" onClick={() => testShare(share)}>{t("common.test")}</button>
                  <button className="btn-secondary min-h-8 px-3 text-xs" onClick={() => openShareFiles(share)} disabled={share.connection_type !== "smb"}>{t("common.files")}</button>
                  <button className="btn-secondary min-h-8 px-3 text-xs" onClick={() => startEditShare(share)}>
                    <Pencil size={15} aria-hidden="true" />
                    {t("common.edit")}
                  </button>
                </div>
              </article>
            ))}
            {shares.length === 0 && <p className="rounded-md border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{t("shares.empty")}</p>}
          </div>
        </div>
      </section>
    )
  }

  function DeviceActions({ device, compact = false }) {
    return (
      <div className={compact ? "grid grid-cols-2 gap-1.5" : "mt-3 grid grid-cols-2 gap-1.5"}>
        <button className="btn-secondary min-h-8 px-2.5 text-xs" onClick={() => openShares(device)}>
          <FolderOpen size={17} aria-hidden="true" />
          {t("common.shares")}
        </button>
        <button className="btn-secondary min-h-8 px-2.5 text-xs" onClick={() => openTerminal(device)} disabled={device.connection_type !== "ssh_sftp"}>
          <Terminal size={17} aria-hidden="true" />
          {t("common.terminal")}
        </button>
        <button className="btn-secondary min-h-8 px-2.5 text-xs" onClick={() => openFiles(device)} disabled={!["ssh_sftp", "smb"].includes(device.connection_type)} title={["ssh_sftp", "smb"].includes(device.connection_type) ? t("dashboard.openFiles") : t("dashboard.enableSshOrShare")}>
          <FolderOpen size={17} aria-hidden="true" />
          {t("common.files")}
        </button>
        <button className="btn-secondary min-h-8 px-2.5 text-xs" onClick={() => openStats(device)} disabled={device.connection_type !== "ssh_sftp"}>
          <BarChart3 size={17} aria-hidden="true" />
          {t("common.stats")}
        </button>
        <button className="btn-secondary col-span-2 min-h-8 px-2.5 text-xs" onClick={() => startEdit(device)}>
          <Pencil size={17} aria-hidden="true" />
          {t("common.edit")}
        </button>
      </div>
    )
  }

  function DeviceSummary({ device }) {
    const activeWorkspace = terminalDevice?.id === device.id || (filesTargetType === "device" && filesDevice?.id === device.id) || sharesDevice?.id === device.id || statsDevice?.id === device.id
    return (
      <article
        className={`relative rounded border px-3 py-2.5 ${activeWorkspace ? "border-signal bg-surface ring-1 ring-signal/20" : "border-transparent bg-panel hover:border-line"}`}
        data-device-id={device.id}
        data-testid="device-summary"
      >
        <div ref={powerMenuDeviceId === device.id ? powerMenuRef : null}>
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <Power
                className={`mt-0.5 shrink-0 ${device.active ? "text-emerald-500" : "text-ink"}`}
                size={16}
                aria-label={device.active ? t("common.active") : t("common.inactive")}
              />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-ink">{device.name}</h3>
                <p className="truncate text-xs text-muted">{device.host}{device.connection_type === "ssh_sftp" ? `:${device.port}` : ""}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {device.connection_type === "ssh_sftp" && (
                    <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">
                      SSH/SFTP
                    </span>
                  )}
                </div>
              </div>
            </div>
            {(device.connection_type === "ssh_sftp" || device.mac_address) && (
              <button
                className={`flex h-8 min-h-0 shrink-0 items-center justify-center gap-1.5 rounded border px-2 text-sm font-semibold transition ${powerMenuDeviceId === device.id ? "border-red-400/70 bg-red-500/15 text-red-500" : "border-red-500/30 bg-red-500/10 text-red-500 hover:border-red-400/70 hover:bg-red-500/15"}`}
                type="button"
                data-testid="device-power-menu"
                onClick={() => setPowerMenuDeviceId((current) => current === device.id ? null : device.id)}
                title={t("dashboard.powerActions")}
                aria-label={t("dashboard.powerActions")}
                aria-haspopup="menu"
                aria-expanded={powerMenuDeviceId === device.id}
              >
                {device.connection_type === "ssh_sftp" ? (
                  <>
                    <RotateCcw size={13} aria-hidden="true" />
                    <PowerOff size={13} aria-hidden="true" />
                  </>
                ) : (
                  <Zap size={14} aria-hidden="true" />
                )}
              </button>
            )}
          </div>
          {powerMenuDeviceId === device.id && (
            <div className="mt-2 overflow-hidden rounded-md border border-line bg-panel shadow-sm" role="menu">
              <div className="border-b border-line px-3 py-2 text-[10px] font-semibold uppercase text-muted">{t("dashboard.powerActions")}</div>
              {device.mac_address && (
                <button className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-ink hover:bg-surface" type="button" role="menuitem" onClick={() => requestDeviceAction(device, "wake")}>
                  <Zap size={14} aria-hidden="true" />
                  {t("dashboard.wakeMachine")}
                </button>
              )}
              {device.connection_type === "ssh_sftp" && (
                <>
                  <button className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-xs font-semibold text-ink hover:bg-surface" type="button" role="menuitem" onClick={() => requestDeviceAction(device, "reboot")}>
                    <RotateCcw size={14} aria-hidden="true" />
                    {t("dashboard.rebootMachine")}
                  </button>
                  <button className="flex w-full items-center gap-2 border-t border-line px-3 py-2 text-left text-xs font-semibold text-red-600 hover:bg-red-500/10" type="button" role="menuitem" onClick={() => requestDeviceAction(device, "shutdown")}>
                    <PowerOff size={14} aria-hidden="true" />
                    {t("dashboard.shutdownMachine")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <DeviceActions device={device} />
      </article>
    )
  }

  function StatGauge({ label, value, detail, tone = "signal" }) {
    const radius = 42
    const circumference = 2 * Math.PI * radius
    const strokeOffset = circumference - (circumference * value) / 100
    const strokeClass = tone === "warning" ? "stroke-warning" : "stroke-signal"
    return (
      <div className="rounded border border-line bg-panel p-4">
        <div className="flex items-center gap-4">
          <div className="relative h-28 w-28 shrink-0">
            <svg className="-rotate-90" viewBox="0 0 100 100" aria-hidden="true">
              <circle className="stroke-line/70" cx="50" cy="50" r={radius} fill="none" strokeWidth="9" />
              <circle
                className={strokeClass}
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                strokeLinecap="round"
                strokeWidth="9"
                strokeDasharray={circumference}
                strokeDashoffset={strokeOffset}
              />
            </svg>
            <div className="absolute inset-0 grid place-items-center">
              <span className="text-2xl font-semibold text-ink">{value}%</span>
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase text-muted">{label}</p>
            {detail && <p className="mt-2 text-sm font-semibold text-ink">{detail}</p>}
            <p className="mt-1 text-xs text-muted">{t("stats.used")}</p>
          </div>
        </div>
      </div>
    )
  }

  function renderStatsPanel() {
    if (!statsDevice) return null
    const memoryPercent = percent(statsData?.memory_used, statsData?.memory_total)
    const diskPercent = percent(statsData?.disk_used, statsData?.disk_total)
    const cpuPercent = roundedPercent(statsData?.cpu_usage_percent)
    const coreValues = statsData?.cpu_core_usage_percent?.length ? statsData.cpu_core_usage_percent.map(roundedPercent) : []
    return (
      <section className="rounded-md border border-line bg-panel">
        <header className="flex flex-col gap-3 border-b border-line px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{t("stats.title", { name: statsDevice.name })}</h3>
            <p className="truncate text-xs text-muted">{statsDevice.host}{statsDevice.connection_type === "ssh_sftp" ? `:${statsDevice.port}` : ""}</p>
          </div>
          <div className="flex gap-2">
            <button className="btn-secondary px-3" onClick={() => openStats(statsDevice)} disabled={statsLoading}>{t("common.refresh")}</button>
            <button className="btn-secondary px-3" onClick={closeWorkspace}>
              <X size={17} aria-hidden="true" />
              {t("common.close")}
            </button>
          </div>
        </header>
        <div className="space-y-3 p-3">
          {statsLoading && <p className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-muted">{t("stats.loading")}</p>}
          {statsData && (
            <>
              <div className="grid items-start gap-3 xl:grid-cols-[1.2fr_0.9fr_0.9fr]">
                <article className="rounded border border-line bg-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase text-muted">CPU</p>
                      <p className="mt-2 text-2xl font-semibold text-ink">{statsData.cpu_cores ? t("stats.cpuCores", { count: statsData.cpu_cores }) : t("stats.unknown")}</p>
                      <p className="mt-1 text-sm text-muted">{statsData.cpu_model || t("stats.unknown")}</p>
                    </div>
                    <BarChart3 className="shrink-0 text-signal" size={24} aria-hidden="true" />
                  </div>
                </article>
                <article className="rounded border border-line bg-panel p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase text-muted">{t("stats.cpuUsage")}</p>
                      <p className="mt-2 text-3xl font-semibold text-ink">{statsData.cpu_usage_percent != null ? `${cpuPercent}%` : t("stats.unknown")}</p>
                      <p className="mt-1 text-xs text-muted">{t("stats.currentUsage")}</p>
                    </div>
                    <div className="rounded bg-signal/10 px-2 py-1 text-xs font-semibold text-signal">{t("stats.live")}</div>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    {coreValues.length > 0 ? coreValues.map((value, index) => (
                      <div key={index} className="min-w-0">
                        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase text-muted">
                          <span>{t("stats.core", { number: index + 1 })}</span>
                          <span>{value}%</span>
                        </div>
                        <div className="h-1.5 overflow-hidden rounded-full bg-line/60">
                          <div className="h-full rounded-full bg-signal" style={{ width: `${value}%` }} />
                        </div>
                      </div>
                    )) : (
                      <p className="col-span-2 text-xs text-muted">{t("stats.coreUnavailable")}</p>
                    )}
                  </div>
                </article>
                <article className="rounded border border-line bg-panel p-4">
                  <p className="text-xs font-semibold uppercase text-muted">{t("stats.uptime")}</p>
                  <p className="mt-2 text-2xl font-semibold text-ink">{formatDuration(statsData.uptime_seconds) || t("stats.unknown")}</p>
                  <p className="mt-1 text-sm text-muted">{statsDevice.name}</p>
                </article>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <StatGauge label={t("stats.memory")} value={memoryPercent} detail={`${formatBytes(statsData.memory_used)} / ${formatBytes(statsData.memory_total)}`} />
                <StatGauge label={t("stats.disk", { mount: statsData.disk_mount || "/" })} value={diskPercent} detail={`${formatBytes(statsData.disk_used)} / ${formatBytes(statsData.disk_total)}`} tone={diskPercent > 85 ? "warning" : "signal"} />
              </div>
            </>
          )}
        </div>
      </section>
    )
  }

  return (
    <div className="space-y-4">
      <section className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-ink sm:text-2xl">{t("dashboard.devices")}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t("dashboard.intro")}</p>
        </div>
        <button className="btn-primary w-full sm:w-auto" onClick={startCreate}>
          <Plus size={18} aria-hidden="true" />
          {t("dashboard.addMachine")}
        </button>
      </section>

      {message && <p className="rounded-md border border-line bg-panel px-3 py-2.5 text-sm text-ink">{message}</p>}

      <TransferJobsPanel />

      {showForm && (
        <section className="rounded-md border border-line bg-panel p-3">
          <h3 className="mb-4 text-lg font-semibold text-ink">{editingDevice ? t("dashboard.editMachine") : t("dashboard.newMachine")}</h3>
          <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" onSubmit={submit} noValidate>
            <div>
              <label className="label" htmlFor="name">{t("dashboard.friendlyName")}</label>
              <input className="field mt-1" id="name" name="name" value={form.name} onChange={update} required />
            </div>
            <div>
              <label className="label" htmlFor="host">{t("dashboard.hostIp")}</label>
              <input className="field mt-1" id="host" name="host" value={form.host} onChange={update} required />
            </div>
            <div>
              <label className="label" htmlFor="mac_address">{t("dashboard.macAddress")}</label>
              <input className="field mt-1" id="mac_address" name="mac_address" value={form.mac_address} onChange={update} placeholder="AA:BB:CC:DD:EE:FF" />
            </div>
            <label className="flex min-h-11 items-end gap-3 text-sm text-ink">
              <input
                className="mb-3 h-5 w-5 rounded border-line bg-surface accent-signal"
                type="checkbox"
                checked={form.connection_type === "ssh_sftp"}
                onChange={(event) => setForm({ ...form, connection_type: event.target.checked ? "ssh_sftp" : "machine", auth_method: event.target.checked ? "password" : "none", username: event.target.checked ? form.username : "", password: "", private_key: "" })}
              />
              {t("dashboard.enableSsh")}
            </label>
            {form.connection_type === "ssh_sftp" && (
              <>
                <div>
                  <label className="label" htmlFor="port">{t("dashboard.sshPort")}</label>
                  <input className="field mt-1" id="port" name="port" type="number" min="1" max="65535" value={form.port} onChange={update} required />
                </div>
                <div>
                  <label className="label" htmlFor="username">{t("dashboard.sshUser")}</label>
                  <input className="field mt-1" id="username" name="username" value={form.username} onChange={update} required />
                </div>
                <div>
                  <label className="label" htmlFor="auth_method">{t("dashboard.sshAuth")}</label>
                  <select className="field mt-1" id="auth_method" name="auth_method" value={form.auth_method} onChange={update}>
                    <option value="password">{t("common.password")}</option>
                    <option value="ssh_key">{t("dashboard.sshKey")}</option>
                  </select>
                </div>
              </>
            )}
            {form.connection_type === "ssh_sftp" && form.auth_method === "password" ? (
              <div className="md:col-span-2 xl:col-span-3">
                <label className="label" htmlFor="password">{t("common.password")}</label>
                <input className="field mt-1" id="password" name="password" type="password" value={form.password} onChange={update} autoComplete="new-password" required={!editingDevice} placeholder={editingDevice ? t("dashboard.leavePassword") : ""} />
              </div>
            ) : form.connection_type === "ssh_sftp" && form.auth_method === "ssh_key" ? (
              <div className="md:col-span-2 xl:col-span-3">
                <label className="label" htmlFor="private_key">{t("dashboard.privateKey")}</label>
                <textarea className="field mt-1 min-h-36" id="private_key" name="private_key" value={form.private_key} onChange={update} required={!editingDevice} placeholder={editingDevice ? t("dashboard.leaveKey") : ""} />
              </div>
            ) : null}
            <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
              <input className="h-5 w-5 rounded border-line bg-surface accent-signal" type="checkbox" name="active" checked={form.active} onChange={update} />
              {t("common.active")}
            </label>
            <div className="flex flex-col gap-3 sm:flex-row md:col-span-2 xl:col-span-3">
              <button className="btn-primary" disabled={busy}>{busy ? t("common.saving") : editingDevice ? t("dashboard.saveChanges") : t("dashboard.saveMachine")}</button>
              <button type="button" className="btn-secondary" onClick={cancelForm}>{t("common.cancel")}</button>
              {editingDevice?.connection_type === "ssh_sftp" && (
                <div className="flex flex-col gap-3 sm:ml-auto sm:flex-row">
                  <button type="button" className="btn-secondary" onClick={() => requestDeviceAction(editingDevice, "reboot")}>
                    <RotateCcw size={17} aria-hidden="true" />
                    {t("dashboard.rebootMachine")}
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => requestDeviceAction(editingDevice, "wake")} disabled={!form.mac_address}>
                    <Zap size={17} aria-hidden="true" />
                    {t("dashboard.wakeMachine")}
                  </button>
                  <button type="button" className="btn-danger" onClick={() => requestDeviceAction(editingDevice, "shutdown")}>
                    <PowerOff size={17} aria-hidden="true" />
                    {t("dashboard.shutdownMachine")}
                  </button>
                </div>
              )}
              {editingDevice && (
                <button type="button" className={`btn-danger ${editingDevice.connection_type === "ssh_sftp" ? "" : "sm:ml-auto"}`} onClick={() => removeDevice(editingDevice)}>
                  <Trash2 size={17} aria-hidden="true" />
                  {t("dashboard.deleteMachine")}
                </button>
              )}
            </div>
          </form>
        </section>
      )}

      {devices.length === 0 ? (
        <section className="grid min-h-56 place-items-center rounded-md border border-dashed border-line bg-panel/60 p-6 text-center">
          <div>
            <Server className="mx-auto mb-3 text-muted" size={40} aria-hidden="true" />
            <h3 className="text-lg font-semibold text-ink">{t("dashboard.noMachines")}</h3>
            <p className="mt-1 text-sm text-muted">{t("dashboard.noMachinesHint")}</p>
          </div>
        </section>
      ) : (
        <section className="grid gap-3 lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside
            ref={deviceListRef}
            onScroll={(event) => {
              deviceListScrollTopRef.current = event.currentTarget.scrollTop
            }}
            className="space-y-2 rounded-md border border-line bg-panel p-2 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100vh-5.25rem)] lg:overflow-auto"
          >
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
            ) : statsDevice ? (
              renderStatsPanel()
            ) : (
              <section className="grid min-h-[560px] place-items-center rounded-md border border-line bg-panel/60 p-6 text-center">
                <div>
                  <Server className="mx-auto mb-3 text-muted" size={42} aria-hidden="true" />
                  <h3 className="text-lg font-semibold text-ink">{t("dashboard.chooseAction")}</h3>
                  <p className="mt-1 max-w-md text-sm text-muted">{t("dashboard.chooseActionHint")}</p>
                </div>
              </section>
            )}
          </div>
        </section>
      )}
      {shareDeleteTarget && (
        <ConfirmDialog
          title={t("shares.deleteTitle")}
          message={t("shares.deleteMessage", { name: shareDeleteTarget.name })}
          confirmLabel={t("common.delete")}
          danger
          onConfirm={removeShareConfirmed}
          onCancel={() => setShareDeleteTarget(null)}
        />
      )}
      {deviceDeleteTarget && (
        <ConfirmDialog
          title={t("dashboard.deleteTitle")}
          message={t("dashboard.deleteMessage", { name: deviceDeleteTarget.name })}
          confirmLabel={t("dashboard.deleteMachine")}
          danger
          onConfirm={removeDeviceConfirmed}
          onCancel={() => setDeviceDeleteTarget(null)}
        />
      )}
      {deviceActionTarget && (
        <ConfirmDialog
          title={t(`dashboard.${deviceActionTarget.action}Title`)}
          message={t(`dashboard.${deviceActionTarget.action}Message`, { name: deviceActionTarget.device.name })}
          confirmLabel={t(`dashboard.${deviceActionTarget.action}Machine`)}
          danger={deviceActionTarget.action === "shutdown"}
          onConfirm={runDeviceActionConfirmed}
          onCancel={() => setDeviceActionTarget(null)}
        />
      )}
    </div>
  )
}
