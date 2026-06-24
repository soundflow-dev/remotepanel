import { useEffect, useState } from "react"
import { Copy, Download, File, Folder, FolderPlus, MoveRight, RefreshCw, Trash2, X } from "lucide-react"

import { api } from "../api/client"

function joinPath(base, name) {
  if (!base || base === ".") return name
  return `${base.replace(/\/$/, "")}/${name}`
}

function formatSize(size) {
  if (size == null) return ""
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export function FileExplorer({ device, onClose, embedded = false }) {
  const [path, setPath] = useState(".")
  const [listing, setListing] = useState({ path: ".", parent: ".", entries: [] })
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState([])
  const [transferAction, setTransferAction] = useState(null)
  const [destinationDeviceId, setDestinationDeviceId] = useState(device.id)
  const [destinationPath, setDestinationPath] = useState(".")
  const [destinationListing, setDestinationListing] = useState({ path: ".", parent: ".", entries: [] })
  const [sftpDevices, setSftpDevices] = useState([device])

  async function load(nextPath = path) {
    setBusy(true)
    setMessage("")
    try {
      const result = await api.listFiles(device.id, nextPath)
      setListing(result)
      setPath(result.path)
      setSelectedPaths([])
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    load(".")
    api.listDevices()
      .then((devices) => {
        const available = devices.filter((item) => item.connection_type === "ssh_sftp" && item.active)
        setSftpDevices(available.length > 0 ? available : [device])
      })
      .catch(() => setSftpDevices([device]))
  }, [device])

  async function createFolder() {
    const name = window.prompt("Folder name")
    if (!name) return
    await api.mkdir(device.id, joinPath(path, name))
    await load(path)
  }

  async function renameEntry(entry) {
    const nextName = window.prompt("New name", entry.name)
    if (!nextName || nextName === entry.name) return
    await api.renamePath(device.id, entry.path, joinPath(path, nextName))
    await load(path)
  }

  async function deleteEntry(entry) {
    if (!window.confirm(`Delete ${entry.name}?`)) return
    await api.deletePath(device.id, entry.path)
    await load(path)
  }

  async function deleteSelected() {
    if (selectedPaths.length === 0) return
    if (!window.confirm(`Delete ${selectedPaths.length} selected item${selectedPaths.length === 1 ? "" : "s"}?`)) return
    setBusy(true)
    setMessage("")
    try {
      for (const selectedPath of selectedPaths) {
        await api.deletePath(device.id, selectedPath)
      }
      await load(path)
      setMessage("Selected items deleted.")
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  function downloadEntry(entry) {
    window.location.href = `/api/files/${device.id}/download?path=${encodeURIComponent(entry.path)}`
  }

  function openTransfer(action) {
    setTransferAction(action)
    setDestinationDeviceId(device.id)
    loadDestination(device.id, path)
    setMessage("")
  }

  async function loadDestination(deviceId = destinationDeviceId, nextPath = destinationPath) {
    setBusy(true)
    setMessage("")
    try {
      const result = await api.listFiles(deviceId, nextPath)
      setDestinationDeviceId(Number(deviceId))
      setDestinationPath(result.path)
      setDestinationListing(result)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function createDestinationFolder() {
    const name = window.prompt("Folder name")
    if (!name) return
    await api.mkdir(destinationDeviceId, joinPath(destinationPath, name))
    await loadDestination(destinationDeviceId, destinationPath)
  }

  async function runTransfer(event) {
    event.preventDefault()
    if (!transferAction || selectedPaths.length === 0) return
    setBusy(true)
    setMessage("")
    try {
      const result = await api.transferSftp({
        source_device_id: device.id,
        destination_device_id: Number(destinationDeviceId),
        source_paths: selectedPaths,
        destination_path: destinationPath,
        action: transferAction,
      })
      setTransferAction(null)
      await load(path)
      setMessage(`${result.action === "move" ? "Moved" : "Copied"} ${result.items} item${result.items === 1 ? "" : "s"} (${result.files_copied} file${result.files_copied === 1 ? "" : "s"}).`)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  function toggleSelection(entry) {
    setSelectedPaths((current) => {
      if (current.includes(entry.path)) {
        return current.filter((item) => item !== entry.path)
      }
      return [...current, entry.path]
    })
  }

  function toggleSelectAll() {
    if (selectedPaths.length === listing.entries.length) {
      setSelectedPaths([])
    } else {
      setSelectedPaths(listing.entries.map((entry) => entry.path))
    }
  }

  const selectedCount = selectedPaths.length
  const allSelected = listing.entries.length > 0 && selectedCount === listing.entries.length

  return (
    <section className={embedded ? "flex min-h-[620px] flex-col overflow-hidden rounded-lg border border-line bg-surface" : "fixed inset-0 z-20 flex flex-col bg-surface"}>
      <header className="flex flex-col gap-3 border-b border-line bg-panel px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{device.name} files</h2>
          <p className="truncate text-xs text-muted">{path}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary px-3" onClick={() => load(path)} disabled={busy} title="Refresh">
            <RefreshCw size={17} aria-hidden="true" />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button className="btn-secondary px-3" onClick={createFolder} title="Create folder">
            <FolderPlus size={17} aria-hidden="true" />
            <span className="hidden sm:inline">Folder</span>
          </button>
          <button className="btn-secondary px-3" onClick={onClose} title="Close files">
            <X size={17} aria-hidden="true" />
            <span className="hidden sm:inline">Close</span>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3 sm:p-4">
        {message && <p className="mb-3 rounded-md border border-line bg-panel px-4 py-3 text-sm text-ink">{message}</p>}

        {selectedCount > 0 && (
          <div className="mb-3 flex flex-col gap-3 rounded-md border border-line bg-panel px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ink">{selectedCount} selected</p>
            <div className="flex flex-wrap gap-2">
              <button className="btn-secondary min-h-9 px-3" onClick={() => openTransfer("copy")} disabled={busy}>
                <Copy size={15} aria-hidden="true" />
                Copy
              </button>
              <button className="btn-secondary min-h-9 px-3" onClick={() => openTransfer("move")} disabled={busy}>
                <MoveRight size={15} aria-hidden="true" />
                Move
              </button>
              <button className="btn-danger min-h-9 px-3" onClick={deleteSelected} disabled={busy}>
                <Trash2 size={15} aria-hidden="true" />
                Delete
              </button>
              <button className="btn-secondary min-h-9 px-3" onClick={() => setSelectedPaths([])}>
                Clear
              </button>
            </div>
          </div>
        )}

        {transferAction && (
          <form className="mb-3 overflow-hidden rounded-md border border-line bg-panel" onSubmit={runTransfer}>
            <div className="border-b border-line px-4 py-3">
              <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                <div>
                  <label className="label" htmlFor="destination_device">Destination machine</label>
                  <select
                    className="field mt-1"
                    id="destination_device"
                    value={destinationDeviceId}
                    onChange={(event) => loadDestination(Number(event.target.value), ".")}
                  >
                    {sftpDevices.map((item) => (
                      <option key={item.id} value={item.id}>{item.name} · {item.host}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-secondary min-h-11" type="button" onClick={createDestinationFolder} disabled={busy}>
                    <FolderPlus size={16} aria-hidden="true" />
                    Folder
                  </button>
                  <button className="btn-primary min-h-11" disabled={busy}>{transferAction === "move" ? "Move here" : "Copy here"}</button>
                  <button className="btn-secondary min-h-11" type="button" onClick={() => setTransferAction(null)}>Cancel</button>
                </div>
              </div>
              <p className="mt-3 truncate text-xs text-muted">Destination: {destinationPath}</p>
            </div>

            <div className="max-h-80 overflow-auto">
              <button
                className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-sm text-ink hover:bg-surface disabled:cursor-not-allowed disabled:opacity-45"
                type="button"
                onClick={() => loadDestination(destinationDeviceId, destinationListing.parent)}
                disabled={destinationPath === "." || destinationPath === "/"}
              >
                <Folder size={18} aria-hidden="true" />
                ..
              </button>
              {destinationListing.entries.filter((entry) => entry.type === "directory").map((entry) => (
                <button
                  key={entry.path}
                  className="flex w-full min-w-0 items-center gap-3 border-b border-line px-4 py-3 text-left last:border-b-0 hover:bg-surface"
                  type="button"
                  onClick={() => loadDestination(destinationDeviceId, entry.path)}
                >
                  <Folder className="shrink-0 text-teal-300" size={19} aria-hidden="true" />
                  <span className="truncate text-sm font-medium text-ink">{entry.name}</span>
                </button>
              ))}
              {destinationListing.entries.filter((entry) => entry.type === "directory").length === 0 && (
                <p className="px-4 py-8 text-center text-sm text-muted">No folders here</p>
              )}
            </div>
          </form>
        )}

        <div className="overflow-hidden rounded-lg border border-line bg-panel">
          {listing.entries.length > 0 && (
            <label className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm text-muted">
              <input className="h-5 w-5 rounded border-line bg-surface accent-teal-400" type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              Select all
            </label>
          )}
          <button className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-sm text-ink hover:bg-surface" onClick={() => load(listing.parent)} disabled={path === "." || path === "/"}>
            <Folder size={18} aria-hidden="true" />
            ..
          </button>
          {listing.entries.map((entry) => (
            <div key={entry.path} className={`grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 md:grid-cols-[1fr_120px_180px_auto] ${selectedPaths.includes(entry.path) ? "bg-surface" : ""}`}>
              <div className="flex min-w-0 items-center gap-3">
                <input className="h-5 w-5 shrink-0 rounded border-line bg-surface accent-teal-400" type="checkbox" checked={selectedPaths.includes(entry.path)} onChange={() => toggleSelection(entry)} onClick={(event) => event.stopPropagation()} />
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => entry.type === "directory" ? load(entry.path) : toggleSelection(entry)}>
                  {entry.type === "directory" ? <Folder className="shrink-0 text-teal-300" size={19} aria-hidden="true" /> : <File className="shrink-0 text-muted" size={19} aria-hidden="true" />}
                  <span className="truncate text-sm font-medium text-ink">{entry.name}</span>
                </button>
              </div>
              <span className="hidden text-right text-xs text-muted md:block">{entry.type === "file" ? formatSize(entry.size) : ""}</span>
              <span className="hidden text-xs text-muted md:block">{entry.modified_at ? new Date(entry.modified_at).toLocaleString() : ""}</span>
              <div className="flex justify-end gap-2">
                {entry.type === "file" && (
                  <button className="btn-secondary min-h-9 px-2" onClick={() => downloadEntry(entry)} title="Download">
                    <Download size={15} aria-hidden="true" />
                  </button>
                )}
                <button className="btn-secondary min-h-9 px-2" onClick={() => renameEntry(entry)} title="Rename">
                  Rename
                </button>
                <button className="btn-danger min-h-9 px-2" onClick={() => deleteEntry(entry)} title="Delete">
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
          {listing.entries.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">Empty folder</p>
          )}
        </div>
      </div>
    </section>
  )
}
