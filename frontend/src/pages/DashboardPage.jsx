import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Activity, Battery, BarChart3, Download, FileText, Gauge, FolderOpen, Pencil, Play, Plus, Power, PowerOff, RotateCcw, Save, Search, Server, Terminal, Trash2, Upload, X, Zap } from "lucide-react"

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

const emptyUpsForm = {
  enabled: false,
  host: "",
  port: 3493,
  ups_name: "",
  username: "",
  password: "",
  battery_threshold: 25,
  poll_interval_seconds: 60,
  selected_device_ids: [],
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

export function DashboardPage({ setTopAction }) {
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
  const [filesTargetLabel, setFilesTargetLabel] = useState("")
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
  const [transferQueue, setTransferQueue] = useState([])
  const [transferMode, setTransferMode] = useState(() => window.localStorage.getItem("remotepanel-transfer-mode") || "balanced")
  const [startingQueue, setStartingQueue] = useState(false)
  const [destinationContext, setDestinationContext] = useState(null)
  const [cancellingJobId, setCancellingJobId] = useState(null)
  const [transferReport, setTransferReport] = useState(null)
  const [transferReportLoading, setTransferReportLoading] = useState(false)
  const [upsConfig, setUpsConfig] = useState(null)
  const [upsForm, setUpsForm] = useState(emptyUpsForm)
  const [upsStatus, setUpsStatus] = useState(null)
  const [showUpsForm, setShowUpsForm] = useState(false)
  const [upsBusy, setUpsBusy] = useState(false)
  const [showAdminTools, setShowAdminTools] = useState(false)
  const [adminBusy, setAdminBusy] = useState(false)
  const [auditEvents, setAuditEvents] = useState([])
  const [discoveryNetwork, setDiscoveryNetwork] = useState("")
  const [discoveryResults, setDiscoveryResults] = useState([])
  const [shareDeleteTarget, setShareDeleteTarget] = useState(null)
  const [deviceDeleteTarget, setDeviceDeleteTarget] = useState(null)
  const [deviceActionTarget, setDeviceActionTarget] = useState(null)
  const [powerMenuDeviceId, setPowerMenuDeviceId] = useState(null)
  const deviceListRef = useRef(null)
  const deviceListScrollTopRef = useRef(0)
  const powerMenuRef = useRef(null)
  const backupFileRef = useRef(null)

  async function loadDevices() {
    setDevices(await api.listDevices())
  }

  async function loadTransferJobs() {
    setTransferJobs(await api.listTransferJobs())
  }

  async function loadUpsConfig() {
    const config = await api.getUpsConfig()
    setUpsConfig(config)
    setUpsForm({
      enabled: config.enabled,
      host: config.host || "",
      port: config.port || 3493,
      ups_name: config.ups_name || "",
      username: config.username || "",
      password: "",
      battery_threshold: config.battery_threshold || 25,
      poll_interval_seconds: config.poll_interval_seconds || 60,
      selected_device_ids: config.selected_device_ids || [],
    })
  }

  async function openTransferReport() {
    if (transferJobs.length === 0) return
    setTransferReportLoading(true)
    try {
      const reports = await Promise.all(transferJobs.map((job) => api.getTransferReport(job.id)))
      setTransferReport(reports)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setTransferReportLoading(false)
    }
  }

  useEffect(() => {
    loadDevices().catch((err) => setMessage(err.message))
    loadTransferJobs().catch(() => {})
    loadUpsConfig().catch(() => {})
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

  useEffect(() => {
    window.localStorage.setItem("remotepanel-transfer-mode", transferMode)
  }, [transferMode])

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

  const updateUps = (event) => {
    const { name, value, type, checked } = event.target
    setUpsForm({ ...upsForm, [name]: type === "checkbox" ? checked : value })
  }

  function toggleUpsDevice(deviceId) {
    const selected = upsForm.selected_device_ids.includes(deviceId)
    setUpsForm({
      ...upsForm,
      selected_device_ids: selected
        ? upsForm.selected_device_ids.filter((id) => id !== deviceId)
        : [...upsForm.selected_device_ids, deviceId],
    })
  }

  function upsPayload() {
    const payload = {
      enabled: Boolean(upsForm.enabled),
      host: upsForm.host.trim(),
      port: Number(upsForm.port) || 3493,
      ups_name: upsForm.ups_name.trim(),
      username: upsForm.username.trim(),
      battery_threshold: Number(upsForm.battery_threshold) || 25,
      poll_interval_seconds: Number(upsForm.poll_interval_seconds) || 60,
      selected_device_ids: upsForm.selected_device_ids,
    }
    if (upsForm.password !== "") {
      payload.password = upsForm.password
    }
    return payload
  }

  async function saveUps(event) {
    event.preventDefault()
    setUpsBusy(true)
    try {
      const config = await api.saveUpsConfig(upsPayload())
      setUpsConfig(config)
      setUpsForm({ ...upsForm, password: "" })
      setMessage(t("ups.saved"))
    } catch (err) {
      setMessage(err.message)
    } finally {
      setUpsBusy(false)
    }
  }

  async function testUps() {
    setUpsBusy(true)
    try {
      const config = await api.saveUpsConfig(upsPayload())
      setUpsConfig(config)
      const result = await api.testUps()
      setUpsStatus(result)
      setMessage(result.message)
      await loadUpsConfig()
    } catch (err) {
      setMessage(err.message)
    } finally {
      setUpsBusy(false)
    }
  }

  async function exportBackup() {
    setAdminBusy(true)
    try {
      const response = await api.exportBackup()
      const blob = await response.blob()
      const disposition = response.headers.get("Content-Disposition") || ""
      const match = disposition.match(/filename="([^"]+)"/)
      const filename = match?.[1] || "remotepanel-backup.json"
      const url = window.URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      setMessage(t("admin.backupDownloaded"))
    } catch (err) {
      setMessage(err.message)
    } finally {
      setAdminBusy(false)
    }
  }

  async function restoreBackup(event) {
    const file = event.target.files?.[0]
    if (!file) return
    setAdminBusy(true)
    try {
      const backup = JSON.parse(await file.text())
      const result = await api.restoreBackup(backup, true)
      await loadDevices()
      await loadUpsConfig()
      setMessage(t("admin.restoreComplete", { devices: result.devices, shares: result.shares }))
    } catch (err) {
      setMessage(err.message)
    } finally {
      event.target.value = ""
      setAdminBusy(false)
    }
  }

  async function loadAuditEvents() {
    setAdminBusy(true)
    try {
      setAuditEvents(await api.listAuditEvents())
    } catch (err) {
      setMessage(err.message)
    } finally {
      setAdminBusy(false)
    }
  }

  async function scanNetwork() {
    if (!discoveryNetwork.trim()) return
    setAdminBusy(true)
    try {
      setDiscoveryResults(await api.scanNetwork(discoveryNetwork.trim()))
    } catch (err) {
      setMessage(err.message)
    } finally {
      setAdminBusy(false)
    }
  }

  function useDiscoveredHost(host) {
    setEditingDevice(null)
    setForm({
      ...emptyForm,
      name: host.hostname || host.ip,
      connection_type: host.open_ports.includes(22) ? "ssh_sftp" : "machine",
      host: host.ip,
      mac_address: host.mac_address || "",
      port: host.open_ports.includes(22) ? 22 : emptyForm.port,
      auth_method: host.open_ports.includes(22) ? "password" : "none",
      active: true,
    })
    setShowForm(true)
    setMessage(t("admin.discoverySelected", { host: host.ip }))
  }

  const startCreate = useCallback(() => {
    setEditingDevice(null)
    setForm(emptyForm)
    setShowForm((value) => !value)
    setMessage("")
  }, [])

  useEffect(() => {
    if (!setTopAction) return undefined
    setTopAction(
      <button className="btn-primary hidden sm:inline-flex" onClick={startCreate}>
        <Plus size={18} aria-hidden="true" />
        {t("dashboard.addMachine")}
      </button>,
    )
    return () => setTopAction(null)
  }, [setTopAction, startCreate, t])

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
        setFilesTargetLabel("")
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
    setFilesTargetLabel(device.name)
    setFilesDevice(device)
  }

  function openShareFiles(share) {
    captureDeviceListScroll()
    setTerminalDevice(null)
    setStatsDevice(null)
    setFilesTargetType("share")
    setFilesTargetLabel(sharesDevice ? `${sharesDevice.name} / ${share.name}` : share.name)
    setFilesDevice(share)
  }

  function backToShareList() {
    captureDeviceListScroll()
    setFilesDevice(null)
    setFilesTargetType("device")
    setFilesTargetLabel("")
  }

  function openShares(device) {
    captureDeviceListScroll()
    setTerminalDevice(null)
    setFilesDevice(null)
    setFilesTargetLabel("")
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
    setFilesTargetLabel("")
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

  function queueTransfer(item) {
    setTransferQueue((current) => [item, ...current].slice(0, 50))
  }

  function updateQueuedTransfer(id, values) {
    setTransferQueue((current) => current.map((item) => item.id === id ? { ...item, ...values } : item))
  }

  function destinationContextForQueue() {
    if (!destinationContext) return null
    return {
      destinationTargetType: destinationContext.targetType,
      destinationDeviceId: destinationContext.deviceId,
      destinationDeviceName: destinationContext.deviceName,
      destinationPath: destinationContext.path,
      destinationLabel: destinationContext.label,
    }
  }

  function removeQueuedTransfer(id) {
    setTransferQueue((current) => current.filter((item) => item.id !== id))
  }

  function applyFirstQueueDestinationToAll() {
    const first = transferQueue[0]
    if (!first) return
    setTransferQueue((current) => current.map((item) => ({
      ...item,
      destinationTargetType: first.destinationTargetType,
      destinationDeviceId: first.destinationDeviceId,
      destinationDeviceName: first.destinationDeviceName,
      destinationPath: first.destinationPath,
      destinationLabel: first.destinationLabel,
    })))
  }

  function applyCurrentDestinationToQueuedTransfer(id) {
    const destination = destinationContextForQueue()
    if (!destination) return
    updateQueuedTransfer(id, destination)
  }

  function applyCurrentDestinationToAll() {
    const destination = destinationContextForQueue()
    if (!destination) return
    setTransferQueue((current) => current.map((item) => ({ ...item, ...destination })))
  }

  async function startTransferQueue() {
    if (transferQueue.length === 0) return
    setStartingQueue(true)
    setMessage("")
    try {
      const createdJobs = []
      for (const item of [...transferQueue].reverse()) {
        const job = await api.createTransferJob({
          source_target_type: item.sourceTargetType,
          destination_target_type: item.destinationTargetType,
          source_device_id: item.sourceDeviceId,
          destination_device_id: item.destinationDeviceId,
          source_paths: item.sourcePaths,
          destination_path: item.destinationPath,
          action: item.action,
          transfer_profile: transferMode,
        })
        createdJobs.push(job)
      }
      setTransferJobs((current) => [...createdJobs.reverse(), ...current].slice(0, 20))
      setTransferQueue([])
      setMessage(t("transfers.queueStarted", { count: createdJobs.length, plural: plural(createdJobs.length), mode: t(`transfers.mode.${transferMode}`) }))
    } catch (err) {
      setMessage(err.message)
    } finally {
      setStartingQueue(false)
    }
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

  function TransferReportDialog() {
    if (!transferReport) return null
    const reports = Array.isArray(transferReport) ? transferReport : [transferReport]
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-3">
        <div className="flex max-h-[86vh] w-full max-w-5xl flex-col rounded-md border border-line bg-panel shadow-2xl">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0">
              <h3 className="truncate text-lg font-semibold text-ink">{t("transfers.reportTitle")}</h3>
              <p className="mt-1 text-sm text-muted">{t("transfers.reportSubtitle")}</p>
            </div>
            <button className="btn-secondary px-3" onClick={() => setTransferReport(null)}>
              <X size={17} aria-hidden="true" />
              {t("common.close")}
            </button>
          </header>
          <div className="overflow-auto p-4">
            <div className="space-y-4">
              {reports.map((report) => {
                const job = report.job
                const events = report.events || []
                const errors = events.filter((event) => ["file_error", "failed", "worker_error", "restart_exhausted", "stall"].includes(event.event_type))
                const resumes = events.filter((event) => event.event_type === "file_resume")
                const restarts = events.filter((event) => event.event_type === "restart")
                return (
                  <article key={job.id} className="rounded border border-line bg-surface p-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <h4 className="text-sm font-semibold text-ink">
                          {t("transfers.reportJob", { id: job.id, status: t(`transfers.status.${job.status}`) })}
                        </h4>
                        <p className="mt-1 break-words text-xs text-muted">
                          {t("transfers.jobRoute", { source: job.source_device_name, destination: job.destination_device_name })}
                        </p>
                        <p className="mt-1 text-xs text-muted">
                          {formatBytes(job.transferred_bytes)} / {formatBytes(job.total_bytes)} · {t("transfers.files", { copied: job.copied_files || 0, total: job.total_files || 0 })}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
                        <span className="rounded border border-line bg-panel px-2 py-1">{t("transfers.reportRetries")}: {report.summary?.retries ?? 0}</span>
                        <span className="rounded border border-line bg-panel px-2 py-1">{t("transfers.reportStalls")}: {report.summary?.stalls ?? 0}</span>
                        <span className="rounded border border-line bg-panel px-2 py-1">{t("transfers.reportResumes")}: {report.summary?.resumed_files ?? 0}</span>
                        <span className="rounded border border-line bg-panel px-2 py-1">{t("transfers.reportSkipped")}: {report.summary?.skipped_files ?? 0}</span>
                        <span className="rounded border border-line bg-panel px-2 py-1">{t("transfers.reportErrors")}: {report.summary?.file_errors ?? 0}</span>
                      </div>
                    </div>

                    {job.error && (
                      <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
                        {job.error}
                      </div>
                    )}

                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <div className="rounded border border-line bg-panel p-2">
                        <h5 className="text-xs font-semibold uppercase text-muted">{t("transfers.reportRecovery")}</h5>
                        {resumes.length === 0 && restarts.length === 0 ? (
                          <p className="mt-2 text-sm text-muted">{t("transfers.reportNoRecovery")}</p>
                        ) : (
                          <div className="mt-2 space-y-2">
                            {[...restarts, ...resumes].map((event) => (
                              <div key={event.id} className="rounded border border-line bg-surface px-2 py-1.5 text-xs">
                                <p className="font-semibold text-ink">{event.message}</p>
                                {event.source_path && <p className="mt-1 break-words text-muted">{t("transfers.reportSource")}: {event.source_path}</p>}
                                {event.destination_path && <p className="mt-1 break-words text-muted">{t("transfers.reportDestination")}: {event.destination_path}</p>}
                                {event.details?.rewind_bytes !== undefined && (
                                  <p className="mt-1 text-muted">{t("transfers.reportRewind")}: {formatBytes(event.details.rewind_bytes)}</p>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="rounded border border-line bg-panel p-2">
                        <h5 className="text-xs font-semibold uppercase text-muted">{t("transfers.reportProblems")}</h5>
                        {errors.length === 0 ? (
                          <p className="mt-2 text-sm text-muted">{t("transfers.reportNoProblems")}</p>
                        ) : (
                          <div className="mt-2 space-y-2">
                            {errors.map((event) => (
                              <div key={event.id} className="rounded border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs">
                                <p className="font-semibold text-red-600">{event.message}</p>
                                {event.source_path && <p className="mt-1 break-words text-muted">{t("transfers.reportSource")}: {event.source_path}</p>}
                                {event.destination_path && <p className="mt-1 break-words text-muted">{t("transfers.reportDestination")}: {event.destination_path}</p>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  function TransferJobsPanel() {
    const transferModeLocked = transferJobs.some((job) => ["pending", "running", "cancelling"].includes(job.status))
    const shutdownDevices = devices.filter((device) => device.connection_type === "ssh_sftp")
    const upsCharge = upsStatus?.charge ?? upsConfig?.last_charge
    const upsState = upsStatus?.status ?? upsConfig?.last_status
    const upsError = upsStatus?.ok === false ? upsStatus.message : upsConfig?.last_error

    return (
      <aside className="rounded-md border border-line bg-panel p-3 lg:sticky lg:top-[4.5rem] lg:max-h-[calc(100vh-5.25rem)] lg:overflow-auto">
        <div className="mb-3 rounded border border-line bg-surface p-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Battery className="shrink-0 text-signal" size={17} aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold uppercase text-muted">{t("ups.title")}</p>
                <p className="truncate text-xs text-muted">
                  {upsConfig?.enabled ? t("ups.enabled") : t("ups.disabled")}
                  {upsState ? ` · ${upsState}` : ""}
                  {upsCharge != null ? ` · ${upsCharge}%` : ""}
                </p>
              </div>
            </div>
            <button className="btn-secondary min-h-8 px-2 text-xs" type="button" onClick={() => setShowUpsForm((value) => !value)}>
              {showUpsForm ? t("common.close") : t("ups.configure")}
            </button>
          </div>
          {upsError && <p className="mt-2 rounded border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs text-red-600">{upsError}</p>}
          {showUpsForm && (
            <form className="mt-3 space-y-2" onSubmit={saveUps} noValidate>
              <label className="flex items-center gap-2 text-xs font-semibold text-ink">
                <input className="h-4 w-4 rounded border-line bg-panel accent-signal" type="checkbox" name="enabled" checked={upsForm.enabled} onChange={updateUps} />
                {t("ups.enableAutomation")}
              </label>
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <label className="label" htmlFor="ups-host">{t("ups.host")}</label>
                  <input className="field mt-1" id="ups-host" name="host" value={upsForm.host} onChange={updateUps} placeholder="10.10.20.10" />
                </div>
                <div>
                  <label className="label" htmlFor="ups-port">{t("common.port")}</label>
                  <input className="field mt-1" id="ups-port" name="port" type="number" min="1" max="65535" value={upsForm.port} onChange={updateUps} />
                </div>
                <div>
                  <label className="label" htmlFor="ups-name">{t("ups.upsName")}</label>
                  <input className="field mt-1" id="ups-name" name="ups_name" value={upsForm.ups_name} onChange={updateUps} placeholder="ups" />
                </div>
                <div>
                  <label className="label" htmlFor="ups-threshold">{t("ups.threshold")}</label>
                  <input className="field mt-1" id="ups-threshold" name="battery_threshold" type="number" min="1" max="100" value={upsForm.battery_threshold} onChange={updateUps} />
                </div>
                <div>
                  <label className="label" htmlFor="ups-poll">{t("ups.poll")}</label>
                  <input className="field mt-1" id="ups-poll" name="poll_interval_seconds" type="number" min="15" max="3600" value={upsForm.poll_interval_seconds} onChange={updateUps} />
                </div>
                <div>
                  <label className="label" htmlFor="ups-user">{t("common.user")}</label>
                  <input className="field mt-1" id="ups-user" name="username" value={upsForm.username} onChange={updateUps} />
                </div>
                <div>
                  <label className="label" htmlFor="ups-password">{t("common.password")}</label>
                  <input className="field mt-1" id="ups-password" name="password" type="password" value={upsForm.password} onChange={updateUps} placeholder={upsConfig?.has_password ? t("dashboard.leavePassword") : ""} />
                </div>
              </div>
              <div className="rounded border border-line bg-panel p-2">
                <p className="text-[10px] font-semibold uppercase text-muted">{t("ups.shutdownDevices")}</p>
                <div className="mt-2 max-h-40 space-y-1 overflow-auto">
                  {shutdownDevices.length === 0 ? (
                    <p className="text-xs text-muted">{t("ups.noSshDevices")}</p>
                  ) : shutdownDevices.map((device) => (
                    <label key={device.id} className="flex items-center gap-2 rounded px-1 py-1 text-xs text-ink hover:bg-surface">
                      <input className="h-4 w-4 rounded border-line bg-surface accent-signal" type="checkbox" checked={upsForm.selected_device_ids.includes(device.id)} onChange={() => toggleUpsDevice(device.id)} />
                      <span className="min-w-0 truncate">{device.name}</span>
                    </label>
                  ))}
                </div>
              </div>
              <p className="text-xs leading-relaxed text-muted">{t("ups.behavior")}</p>
              <div className="grid grid-cols-2 gap-2">
                <button className="btn-secondary min-h-9 px-2 text-xs" type="button" onClick={testUps} disabled={upsBusy}>
                  {upsBusy ? t("common.working") : t("common.test")}
                </button>
                <button className="btn-primary min-h-9 px-2 text-xs" disabled={upsBusy}>
                  <Save size={14} aria-hidden="true" />
                  {upsBusy ? t("common.saving") : t("common.save")}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="mb-3 rounded border border-line bg-surface p-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Server className="shrink-0 text-signal" size={17} aria-hidden="true" />
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold uppercase text-muted">{t("admin.title")}</p>
                <p className="truncate text-xs text-muted">{t("admin.subtitle")}</p>
              </div>
            </div>
            <button className="btn-secondary min-h-8 px-2 text-xs" type="button" onClick={() => setShowAdminTools((value) => !value)}>
              {showAdminTools ? t("common.close") : t("admin.open")}
            </button>
          </div>
          {showAdminTools && (
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <button className="btn-secondary min-h-9 px-2 text-xs" type="button" onClick={exportBackup} disabled={adminBusy}>
                  <Download size={14} aria-hidden="true" />
                  {t("admin.backup")}
                </button>
                <button className="btn-secondary min-h-9 px-2 text-xs" type="button" onClick={() => backupFileRef.current?.click()} disabled={adminBusy}>
                  <Upload size={14} aria-hidden="true" />
                  {t("admin.restore")}
                </button>
                <input ref={backupFileRef} className="hidden" type="file" accept="application/json,.json" onChange={restoreBackup} />
              </div>
              <p className="text-xs leading-relaxed text-muted">{t("admin.backupHint")}</p>

              <div className="rounded border border-line bg-panel p-2">
                <p className="text-[10px] font-semibold uppercase text-muted">{t("admin.discovery")}</p>
                <div className="mt-2 flex gap-2">
                  <input className="field min-w-0" value={discoveryNetwork} onChange={(event) => setDiscoveryNetwork(event.target.value)} placeholder="10.10.20.0/24" />
                  <button className="btn-secondary min-h-9 px-2 text-xs" type="button" onClick={scanNetwork} disabled={adminBusy || !discoveryNetwork.trim()}>
                    <Search size={14} aria-hidden="true" />
                  </button>
                </div>
                {discoveryResults.length > 0 && (
                  <div className="mt-2 max-h-40 space-y-1 overflow-auto">
                    {discoveryResults.map((host) => (
                      <div key={host.ip} className="rounded border border-line bg-surface px-2 py-1.5 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-ink">{host.hostname || host.ip}</p>
                            <p className="text-muted">
                              {host.ip} · {host.open_ports.join(", ")}
                              {host.mac_address ? ` · ${host.mac_address}` : ""}
                              {host.already_added ? ` · ${t("admin.alreadyAdded")}` : ""}
                            </p>
                          </div>
                          {!host.already_added && (
                            <button className="btn-secondary min-h-7 px-2 text-[11px]" type="button" onClick={() => useDiscoveredHost(host)}>
                              {t("admin.use")}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded border border-line bg-panel p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase text-muted">{t("admin.audit")}</p>
                  <button className="btn-secondary min-h-8 px-2 text-xs" type="button" onClick={loadAuditEvents} disabled={adminBusy}>{t("common.refresh")}</button>
                </div>
                {auditEvents.length > 0 && (
                  <div className="mt-2 max-h-44 space-y-1 overflow-auto">
                    {auditEvents.map((event) => (
                      <div key={event.id} className="rounded border border-line bg-surface px-2 py-1.5 text-xs">
                        <p className="font-semibold text-ink">{event.action}</p>
                        <p className="text-muted">{event.target_name || event.target_type} · {new Date(event.created_at).toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="shrink-0 text-signal" size={18} aria-hidden="true" />
            <h3 className="truncate text-sm font-semibold text-ink">{t("transfers.title")}</h3>
          </div>
          <div className="flex items-center gap-1.5">
            <button className="btn-secondary min-h-8 px-2 text-xs" onClick={openTransferReport} disabled={transferReportLoading || transferJobs.length === 0}>
              <FileText size={14} aria-hidden="true" />
              {transferReportLoading ? t("common.working") : t("transfers.report")}
            </button>
            <button className="btn-secondary min-h-8 px-2 text-xs" onClick={loadTransferJobs}>{t("common.refresh")}</button>
          </div>
        </div>

        <div className="mb-3 rounded border border-line bg-surface p-2">
          <div className="flex min-w-0 items-center gap-2">
            <Gauge className="text-signal" size={16} aria-hidden="true" />
            <p className="text-xs font-semibold uppercase text-muted">{t("transfers.modeLabel")}</p>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {["safe", "balanced", "turbo"].map((mode) => (
              <button
                key={mode}
                className={`min-h-9 rounded border px-2 text-xs font-semibold transition ${transferMode === mode ? "border-signal bg-signal/10 text-signal" : "border-line bg-panel text-ink hover:bg-surface"}`}
                type="button"
                disabled={transferModeLocked}
                onClick={() => setTransferMode(mode)}
              >
                {t(`transfers.mode.${mode}`)}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">{t(`transfers.modeHint.${transferMode}`)}</p>
          {transferModeLocked && (
            <p className="mt-1 text-xs leading-relaxed text-muted">{t("transfers.modeLocked")}</p>
          )}
        </div>

        {transferQueue.length > 0 && (
          <div className="mb-3 rounded border border-line bg-panel p-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-ink">{t("transfers.queueTitle", { count: transferQueue.length })}</h4>
              <button className="btn-secondary min-h-8 px-2 text-xs" type="button" onClick={() => setTransferQueue([])} disabled={startingQueue}>{t("files.clear")}</button>
            </div>
            <div className="mb-2 grid gap-1.5">
              <button className="btn-primary min-h-9 px-3 text-xs" type="button" onClick={startTransferQueue} disabled={startingQueue}>
                <Play size={15} aria-hidden="true" />
                {startingQueue ? t("common.working") : t("transfers.startQueue")}
              </button>
              {transferQueue.length > 1 && (
                <>
                  <button className="btn-secondary min-h-9 px-3 text-xs" type="button" onClick={applyFirstQueueDestinationToAll} disabled={startingQueue}>
                    {t("transfers.sameDestination")}
                  </button>
                  <button className="btn-secondary min-h-9 px-3 text-xs" type="button" onClick={applyCurrentDestinationToAll} disabled={startingQueue || !destinationContext}>
                    {t("transfers.useCurrentForAll")}
                  </button>
                </>
              )}
            </div>
            {destinationContext && (
              <p className="mb-2 rounded border border-line bg-surface px-2 py-1.5 text-xs text-muted">
                {t("transfers.currentDestination", { target: destinationContext.deviceName, path: destinationContext.label })}
              </p>
            )}
            <div className="space-y-2">
              {transferQueue.map((item) => (
                <article key={item.id} className="rounded border border-line bg-surface p-2">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-ink">{t("transfers.queueItem", { count: item.sourcePaths.length, plural: plural(item.sourcePaths.length), source: item.sourceDeviceName })}</p>
                      <p className="truncate text-[11px] text-muted">{item.destinationDeviceName}</p>
                    </div>
                    <button className="btn-secondary min-h-8 px-2 text-xs" type="button" onClick={() => removeQueuedTransfer(item.id)} disabled={startingQueue}>
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="mt-2 rounded border border-line bg-panel px-2 py-1.5">
                    <p className="text-[10px] font-semibold uppercase text-muted">{t("transfers.destinationPath")}</p>
                    <p className="mt-1 break-words text-xs text-ink">{item.destinationDeviceName}: {item.destinationLabel || item.destinationPath}</p>
                  </div>
                  <button className="btn-secondary mt-2 min-h-8 w-full px-2 text-xs" type="button" onClick={() => applyCurrentDestinationToQueuedTransfer(item.id)} disabled={startingQueue || !destinationContext}>
                    {t("transfers.useCurrentDestination")}
                  </button>
                </article>
              ))}
            </div>
          </div>
        )}

        {transferJobs.length === 0 ? null : (
          <div className="rounded border border-line bg-panel p-2">
            <div className="space-y-2">
              {transferJobs.map((job) => {
                const progress = jobProgress(job)
                const verb = job.action === "move" ? t("common.move") : t("common.copy")
                const speed = job.status === "completed" ? averageJobSpeed(job) : job.speed_bytes_per_second
                const eta = jobEta(job, speed)
                const canCancel = ["pending", "running"].includes(job.status)
                const canDismiss = ["completed", "failed", "cancelled", "cancelling"].includes(job.status)
                const itemPlural = plural(job.source_paths.length)
                return (
                  <article key={job.id} className="rounded border border-line bg-surface p-2">
                    <div className="flex flex-col gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold leading-snug text-ink">
                          {t("transfers.jobTitle", { verb, count: job.source_paths.length, plural: itemPlural })}
                        </p>
                        <p className="mt-1 break-words text-xs leading-relaxed text-muted">
                          {t("transfers.jobRoute", { source: job.source_device_name, destination: job.destination_device_name })}
                        </p>
                        <p className="mt-1 break-words text-xs leading-relaxed text-muted">
                          {job.status === "failed" || job.status === "cancelled"
                            ? job.error || t(`transfers.status.${job.status}`)
                            : `${formatBytes(job.transferred_bytes)} / ${formatBytes(job.total_bytes)} · ${speed ? formatSpeed(speed) : t("transfers.measuringSpeed")}${eta ? ` · ${t("transfers.eta", { value: eta })}` : ""} · ${t("transfers.files", { copied: job.copied_files || 0, total: job.total_files || 0 })}`}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={`rounded px-2 py-1 text-xs font-semibold ${job.status === "completed" ? "bg-signal/15 text-signal" : job.status === "failed" || job.status === "cancelled" ? "bg-red-500/10 text-red-600" : "bg-panel text-muted"}`}>
                          {t(`transfers.status.${job.status}`)}
                        </span>
                        {canCancel && (
                          <button className="btn-danger min-h-8 px-2 text-xs" onClick={() => cancelTransferJob(job)} disabled={cancellingJobId === job.id || job.status === "cancelling"}>
                            {job.status === "cancelling" || cancellingJobId === job.id ? t("transfers.cancelling") : t("common.cancel")}
                          </button>
                        )}
                        {canDismiss && (
                          <button className="btn-secondary min-h-8 px-2 text-xs" onClick={() => dismissTransferJob(job)} title={t("transfers.hide")}>
                            <X size={14} aria-hidden="true" />
                            {t("common.close")}
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
          </div>
        )}
      </aside>
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
    <div className="space-y-3">
      <button className="btn-primary w-full sm:hidden" onClick={startCreate}>
        <Plus size={18} aria-hidden="true" />
        {t("dashboard.addMachine")}
      </button>

      {message && <p className="rounded-md border border-line bg-panel px-3 py-2.5 text-sm text-ink">{message}</p>}

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

      <section className={`grid gap-3 ${devices.length === 0 ? "lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]" : "lg:grid-cols-[300px_minmax(0,1fr)_320px] xl:grid-cols-[320px_minmax(0,1fr)_360px]"}`}>
        {devices.length > 0 && (
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
        )}

        <div className="min-w-0">
          {terminalDevice ? (
            <SshTerminal device={terminalDevice} onClose={closeWorkspace} embedded />
          ) : filesDevice ? (
            <FileExplorer
              device={filesDevice}
              targetType={filesTargetType}
              targetLabel={filesTargetLabel || filesDevice.name}
              onClose={closeWorkspace}
              clipboard={fileClipboard}
              onClipboardSet={setFileClipboard}
              onClipboardClear={() => setFileClipboard(null)}
              onJobCreated={handleTransferJobCreated}
              onQueueTransfer={queueTransfer}
              onDestinationContextChange={setDestinationContext}
              onRootBack={filesTargetType === "share" ? backToShareList : undefined}
              transferMode={transferMode}
              embedded
            />
          ) : sharesDevice ? (
            renderSharesPanel()
          ) : statsDevice ? (
            renderStatsPanel()
          ) : devices.length === 0 ? (
            <section className="grid min-h-56 place-items-center rounded-md border border-dashed border-line bg-panel/60 p-6 text-center">
              <div>
                <Server className="mx-auto mb-3 text-muted" size={40} aria-hidden="true" />
                <h3 className="text-lg font-semibold text-ink">{t("dashboard.noMachines")}</h3>
                <p className="mt-1 text-sm text-muted">{t("dashboard.noMachinesHint")}</p>
              </div>
            </section>
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

        {TransferJobsPanel()}
      </section>
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
      <TransferReportDialog />
    </div>
  )
}
