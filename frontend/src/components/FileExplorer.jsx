import { useEffect, useState } from "react"
import { ClipboardPaste, Copy, Download, File, Folder, FolderPlus, MoveRight, RefreshCw, Trash2, X } from "lucide-react"

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

function entrySizeLabel(entry) {
  if (entry.type === "directory") return "Folder"
  return formatSize(entry.size) || "0 B"
}

export function FileExplorer({ device, targetType = "device", onClose, clipboard, onClipboardSet, onClipboardClear, onJobCreated, embedded = false }) {
  const [path, setPath] = useState(".")
  const [listing, setListing] = useState({ path: ".", parent: ".", entries: [] })
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState([])

  async function load(nextPath = path) {
    setBusy(true)
    setMessage("")
    try {
      const result = await api.listFiles(targetType, device.id, nextPath)
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
  }, [device])

  async function createFolder() {
    const name = window.prompt("Folder name")
    if (!name) return
    setBusy(true)
    setMessage("")
    try {
      await api.mkdir(targetType, device.id, joinPath(path, name))
      await load(path)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function renameEntry(entry) {
    const nextName = window.prompt("New name", entry.name)
    if (!nextName || nextName === entry.name) return
    setBusy(true)
    setMessage("")
    try {
      await api.renamePath(targetType, device.id, entry.path, joinPath(path, nextName))
      await load(path)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function deleteEntry(entry) {
    if (!window.confirm(`Delete ${entry.name}?`)) return
    setBusy(true)
    setMessage("")
    try {
      await api.deletePath(targetType, device.id, entry.path)
      await load(path)
      setMessage(`${entry.name} deleted.`)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function deleteSelected() {
    if (selectedPaths.length === 0) return
    if (!window.confirm(`Delete ${selectedPaths.length} selected item${selectedPaths.length === 1 ? "" : "s"}?`)) return
    setBusy(true)
    setMessage("")
    try {
      for (const selectedPath of selectedPaths) {
        await api.deletePath(targetType, device.id, selectedPath)
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
    window.location.href = api.downloadUrl(targetType, device.id, entry.path)
  }

  function copySelected(action) {
    if (selectedPaths.length === 0) return
    onClipboardSet({
      action,
      sourceTargetType: targetType,
      sourceDeviceId: device.id,
      sourceDeviceName: device.name,
      sourcePaths: selectedPaths,
    })
    setMessage(`${selectedPaths.length} item${selectedPaths.length === 1 ? "" : "s"} ready to ${action}. Navigate to a destination folder and paste.`)
    setSelectedPaths([])
  }

  async function pasteHere() {
    if (!clipboard) return
    const selectedEntries = listing.entries.filter((entry) => selectedPaths.includes(entry.path))
    const selectedDirectory = selectedEntries.length === 1 && selectedEntries[0].type === "directory" ? selectedEntries[0] : null
    const pasteDestination = selectedDirectory ? selectedDirectory.path : path
    setBusy(true)
    setMessage("")
    try {
      const result = await api.createTransferJob({
        source_target_type: clipboard.sourceTargetType ?? "device",
        destination_target_type: targetType,
        source_device_id: clipboard.sourceDeviceId,
        destination_device_id: device.id,
        source_paths: clipboard.sourcePaths,
        destination_path: pasteDestination,
        action: clipboard.action,
      })
      await load(path)
      onClipboardClear()
      if (onJobCreated) {
        onJobCreated(result)
      }
      setMessage(`${result.action === "move" ? "Move" : "Copy"} job started for ${result.source_paths.length} item${result.source_paths.length === 1 ? "" : "s"} to ${selectedDirectory ? selectedDirectory.name : "this folder"}.`)
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
  const selectedEntries = listing.entries.filter((entry) => selectedPaths.includes(entry.path))
  const pasteTarget = selectedEntries.length === 1 && selectedEntries[0].type === "directory" ? selectedEntries[0].name : "this folder"

  return (
    <section className={embedded ? "flex h-[calc(100vh-9rem)] min-h-[620px] flex-col overflow-hidden rounded-lg border border-line bg-surface" : "fixed inset-0 z-20 flex flex-col bg-surface"}>
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

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="sticky top-0 z-10 border-b border-line bg-surface/95 p-3 backdrop-blur sm:p-4">
          {message && <p className="mb-3 rounded-md border border-line bg-panel px-4 py-3 text-sm text-ink">{message}</p>}

          {clipboard && (
            <div className="mb-3 flex flex-col gap-3 rounded-md border border-signal/50 bg-teal-950/20 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink">
                {clipboard.action === "move" ? "Move" : "Copy"} {clipboard.sourcePaths.length} item{clipboard.sourcePaths.length === 1 ? "" : "s"} from {clipboard.sourceDeviceName}
              </p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary min-h-9 px-3" onClick={pasteHere} disabled={busy}>
                  <ClipboardPaste size={15} aria-hidden="true" />
                  Paste to {pasteTarget}
                </button>
                <button className="btn-secondary min-h-9 px-3" onClick={onClipboardClear}>
                  Clear
                </button>
              </div>
            </div>
          )}

          {selectedCount > 0 && (
            <div className="flex flex-col gap-3 rounded-md border border-line bg-panel px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink">{selectedCount} selected</p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary min-h-9 px-3" onClick={() => copySelected("copy")} disabled={busy}>
                  <Copy size={15} aria-hidden="true" />
                  Copy
                </button>
                <button className="btn-secondary min-h-9 px-3" onClick={() => copySelected("move")} disabled={busy}>
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
        </div>

        <div className="m-3 overflow-hidden rounded-lg border border-line bg-panel sm:m-4">
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
            <div key={entry.path} className={`grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_120px_180px_auto] ${selectedPaths.includes(entry.path) ? "bg-surface" : ""}`}>
              <div className="flex min-w-0 items-center gap-3">
                <input className="h-5 w-5 shrink-0 rounded border-line bg-surface accent-teal-400" type="checkbox" checked={selectedPaths.includes(entry.path)} onChange={() => toggleSelection(entry)} onClick={(event) => event.stopPropagation()} />
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => entry.type === "directory" ? load(entry.path) : toggleSelection(entry)}>
                  {entry.type === "directory" ? <Folder className="shrink-0 text-teal-300" size={19} aria-hidden="true" /> : <File className="shrink-0 text-muted" size={19} aria-hidden="true" />}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{entry.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted md:hidden">
                      {entrySizeLabel(entry)}{entry.modified_at ? ` · ${new Date(entry.modified_at).toLocaleString()}` : ""}
                    </span>
                  </span>
                </button>
              </div>
              <span className="hidden text-right text-xs text-muted md:block">{entrySizeLabel(entry)}</span>
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
