import { useEffect, useState } from "react"
import { FolderOpen, Pencil, Plus, Power, Server, Terminal, Trash2, Wifi } from "lucide-react"

import { api } from "../api/client"
import { FileExplorer } from "../components/FileExplorer"
import { SshTerminal } from "../components/SshTerminal"

const emptyForm = {
  name: "",
  connection_type: "ssh_sftp",
  host: "",
  port: 22,
  username: "",
  auth_method: "password",
  password: "",
  private_key: "",
  active: true,
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

  async function loadDevices() {
    setDevices(await api.listDevices())
  }

  useEffect(() => {
    loadDevices().catch((err) => setMessage(err.message))
  }, [])

  const update = (event) => {
    const { name, value, type, checked } = event.target
    if (name === "connection_type") {
      if (value === "ssh_sftp") {
        setForm({ ...form, connection_type: value, port: 22, auth_method: "password" })
      } else if (value === "smb") {
        setForm({ ...form, connection_type: value, port: 445, auth_method: "password" })
      } else {
        setForm({ ...form, connection_type: value, port: 2049, username: "", auth_method: "none", password: "", private_key: "" })
      }
      return
    }
    setForm({ ...form, [name]: type === "checkbox" ? checked : value })
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

  async function submit(event) {
    event.preventDefault()
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
    setTerminalDevice(device)
  }

  function openFiles(device) {
    setTerminalDevice(null)
    setFilesDevice(device)
  }

  function closeWorkspace() {
    setTerminalDevice(null)
    setFilesDevice(null)
  }

  function DeviceActions({ device, compact = false }) {
    return (
      <div className={compact ? "grid grid-cols-2 gap-2" : "mt-4 grid grid-cols-2 gap-2"}>
        <button className="btn-secondary px-3" onClick={() => testDevice(device)} disabled={testingId === device.id}>
          <Wifi size={17} aria-hidden="true" />
          {testingId === device.id ? "Testing" : "Test"}
        </button>
        <button className="btn-secondary px-3" onClick={() => openTerminal(device)} disabled={device.connection_type !== "ssh_sftp"}>
          <Terminal size={17} aria-hidden="true" />
          Terminal
        </button>
        <button className="btn-secondary px-3" onClick={() => openFiles(device)} disabled={device.connection_type !== "ssh_sftp"} title={device.connection_type === "ssh_sftp" ? "Open file explorer" : "SMB/NFS file explorer coming next"}>
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
    const activeWorkspace = terminalDevice?.id === device.id || filesDevice?.id === device.id
    return (
      <article className={`rounded-lg border p-3 ${activeWorkspace ? "border-signal bg-surface" : "border-line bg-panel"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-ink">{device.name}</h3>
            <p className="truncate text-xs text-muted">{device.username ? `${device.username}@` : ""}{device.host}:{device.port}</p>
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
          <p className="mt-1 max-w-2xl text-sm text-muted">Add SSH/SFTP connections and test them from one self-hosted control panel.</p>
        </div>
        <button className="btn-primary w-full sm:w-auto" onClick={startCreate}>
          <Plus size={18} aria-hidden="true" />
          Add connection
        </button>
      </section>

      {message && <p className="rounded-md border border-line bg-panel px-4 py-3 text-sm text-ink">{message}</p>}

      {showForm && (
        <section className="rounded-lg border border-line bg-panel p-4 sm:p-5">
          <h3 className="mb-4 text-lg font-semibold text-ink">{editingDevice ? "Edit connection" : "New connection"}</h3>
          <form className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" onSubmit={submit}>
            <div>
              <label className="label" htmlFor="name">Friendly name</label>
              <input className="field mt-1" id="name" name="name" value={form.name} onChange={update} required />
            </div>
            <div>
              <label className="label" htmlFor="connection_type">Connection type</label>
              <select className="field mt-1" id="connection_type" name="connection_type" value={form.connection_type} onChange={update} disabled={Boolean(editingDevice)}>
                <option value="ssh_sftp">SSH/SFTP</option>
                <option value="smb">SMB</option>
                <option value="nfs">NFS</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="host">Host/IP</label>
              <input className="field mt-1" id="host" name="host" value={form.host} onChange={update} required />
            </div>
            <div>
              <label className="label" htmlFor="port">Port</label>
              <input className="field mt-1" id="port" name="port" type="number" min="1" max="65535" value={form.port} onChange={update} required />
            </div>
            <div>
              <label className="label" htmlFor="username">User</label>
              <input className="field mt-1" id="username" name="username" value={form.username} onChange={update} required={form.connection_type !== "nfs"} />
            </div>
            <div>
              <label className="label" htmlFor="auth_method">Auth method</label>
              <select className="field mt-1" id="auth_method" name="auth_method" value={form.auth_method} onChange={update}>
                {form.connection_type === "nfs" ? (
                  <option value="none">None</option>
                ) : (
                  <>
                    <option value="password">Password</option>
                    {form.connection_type === "ssh_sftp" && <option value="ssh_key">SSH key</option>}
                  </>
                )}
              </select>
            </div>
            {form.auth_method === "none" ? null : form.auth_method === "password" ? (
              <div className="md:col-span-2 xl:col-span-3">
                <label className="label" htmlFor="password">Password</label>
                <input className="field mt-1" id="password" name="password" type="password" value={form.password} onChange={update} autoComplete="new-password" required={!editingDevice} placeholder={editingDevice ? "Leave blank to keep current password" : ""} />
              </div>
            ) : (
              <div className="md:col-span-2 xl:col-span-3">
                <label className="label" htmlFor="private_key">Private key</label>
                <textarea className="field mt-1 min-h-36" id="private_key" name="private_key" value={form.private_key} onChange={update} required={!editingDevice} placeholder={editingDevice ? "Leave blank to keep current SSH key" : ""} />
              </div>
            )}
            <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
              <input className="h-5 w-5 rounded border-line bg-surface accent-teal-400" type="checkbox" name="active" checked={form.active} onChange={update} />
              Active
            </label>
            <div className="flex flex-col gap-3 sm:flex-row md:col-span-2 xl:col-span-3">
              <button className="btn-primary" disabled={busy}>{busy ? "Saving..." : editingDevice ? "Save changes" : "Save connection"}</button>
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
            <p className="mt-1 text-sm text-muted">First launch starts empty. Add your first SSH/SFTP connection when ready.</p>
          </div>
        </section>
      ) : (
        <section className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="space-y-3 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-auto">
            {devices.map((device) => (
              <DeviceSummary key={device.id} device={device} />
            ))}
          </aside>

          <div className="min-w-0">
            {terminalDevice ? (
              <SshTerminal device={terminalDevice} onClose={closeWorkspace} embedded />
            ) : filesDevice ? (
              <FileExplorer device={filesDevice} onClose={closeWorkspace} embedded />
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
    </div>
  )
}
