import { useEffect, useState } from "react"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ClipboardPaste, Copy, Download, File, Folder, FolderPlus, MoveRight, RefreshCw, Search, Trash2, X } from "lucide-react"

import { api } from "../api/client"
import { ConfirmDialog, TextPromptDialog } from "./ModalDialog"

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

function formatModified(value) {
  if (!value) return ""
  return new Date(value).toLocaleString("en-US")
}

function pathCrumbs(currentPath) {
  if (!currentPath || currentPath === "." || currentPath === "/") {
    return [{ label: "Root", path: "." }]
  }
  const parts = currentPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean)
  return [
    { label: "Root", path: "." },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join("/"),
    })),
  ]
}

function sortEntries(entries, sort) {
  const direction = sort.direction === "asc" ? 1 : -1
  return [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1

    let result = 0
    if (sort.key === "size") {
      result = (a.size ?? 0) - (b.size ?? 0)
    } else if (sort.key === "modified") {
      result = (Date.parse(a.modified_at ?? "") || 0) - (Date.parse(b.modified_at ?? "") || 0)
    } else {
      result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    }

    if (result === 0) {
      result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
    }
    return result * direction
  })
}

function filterEntries(entries, query) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return entries
  return entries.filter((entry) => entry.name.toLowerCase().includes(normalizedQuery))
}

export function FileExplorer({ device, targetType = "device", onClose, clipboard, onClipboardSet, onClipboardClear, onJobCreated, embedded = false }) {
  const [path, setPath] = useState(".")
  const [listing, setListing] = useState({ path: ".", parent: ".", entries: [] })
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [selectedPaths, setSelectedPaths] = useState([])
  const [historyState, setHistoryState] = useState({ items: ["."], index: 0 })
  const [sort, setSort] = useState({ key: "name", direction: "asc" })
  const [filterQuery, setFilterQuery] = useState("")
  const [textPrompt, setTextPrompt] = useState(null)
  const [confirmDialog, setConfirmDialog] = useState(null)

  function recordHistoryPath(nextPath) {
    setHistoryState((current) => {
      const base = current.items.slice(0, current.index + 1)
      if (base[base.length - 1] === nextPath) return { items: base, index: base.length - 1 }
      return { items: [...base, nextPath], index: base.length }
    })
  }

  async function load(nextPath = path, options = {}) {
    setBusy(true)
    if (!options.keepMessage) {
      setMessage("")
    }
    try {
      const result = await api.listFiles(targetType, device.id, nextPath)
      setListing(result)
      setPath(result.path)
      setSelectedPaths([])
      setFilterQuery("")
      if (options.recordHistory !== false) {
        recordHistoryPath(result.path)
      }
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    setHistoryState({ items: ["."], index: 0 })
    load(".", { recordHistory: false })
  }, [device, targetType])

  function goBack() {
    if (historyState.index <= 0) return
    const nextIndex = historyState.index - 1
    setHistoryState((current) => ({ ...current, index: nextIndex }))
    load(historyState.items[nextIndex], { recordHistory: false })
  }

  function goForward() {
    if (historyState.index >= historyState.items.length - 1) return
    const nextIndex = historyState.index + 1
    setHistoryState((current) => ({ ...current, index: nextIndex }))
    load(historyState.items[nextIndex], { recordHistory: false })
  }

  function toggleSort(key) {
    setSort((current) => {
      if (current.key !== key) return { key, direction: "asc" }
      return { key, direction: current.direction === "asc" ? "desc" : "asc" }
    })
  }

  function sortIcon(key) {
    if (sort.key !== key) return null
    return sort.direction === "asc" ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />
  }

  async function createFolder() {
    setTextPrompt({
      title: "Create folder",
      label: "Folder name",
      initialValue: "",
      confirmLabel: "Create",
      onSubmit: createFolderWithName,
    })
  }

  async function createFolderWithName(name) {
    setBusy(true)
    setMessage("")
    try {
      await api.mkdir(targetType, device.id, joinPath(path, name))
      setTextPrompt(null)
      await load(path, { keepMessage: true })
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function renameEntry(entry) {
    setTextPrompt({
      title: "Rename item",
      label: "New name",
      initialValue: entry.name,
      confirmLabel: "Rename",
      onSubmit: (nextName) => renameEntryTo(entry, nextName),
    })
  }

  async function renameEntryTo(entry, nextName) {
    if (nextName === entry.name) {
      setTextPrompt(null)
      return
    }
    setBusy(true)
    setMessage("")
    try {
      await api.renamePath(targetType, device.id, entry.path, joinPath(path, nextName))
      setTextPrompt(null)
      await load(path, { keepMessage: true })
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function deleteEntry(entry) {
    setConfirmDialog({
      title: "Delete item",
      message: `Delete ${entry.name}?`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => deleteEntryConfirmed(entry),
    })
  }

  async function deleteEntryConfirmed(entry) {
    setBusy(true)
    setMessage("")
    try {
      const result = await api.deletePath(targetType, device.id, entry.path)
      setMessage(`Deleted ${result.path ?? entry.name}.`)
      setConfirmDialog(null)
      await load(path, { keepMessage: true })
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function deleteSelected() {
    if (selectedPaths.length === 0) return
    setConfirmDialog({
      title: "Delete selected items",
      message: `Delete ${selectedPaths.length} selected item${selectedPaths.length === 1 ? "" : "s"}?`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: deleteSelectedConfirmed,
    })
  }

  async function deleteSelectedConfirmed() {
    setBusy(true)
    setMessage("")
    try {
      for (const selectedPath of selectedPaths) {
        try {
          await api.deletePath(targetType, device.id, selectedPath)
        } catch (err) {
          throw new Error(`Failed deleting ${selectedPath}: ${err.message}`)
        }
      }
      setMessage("Selected items deleted.")
      setConfirmDialog(null)
      await load(path, { keepMessage: true })
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
    const selectedEntries = sortedEntries.filter((entry) => selectedPaths.includes(entry.path))
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
    const visiblePaths = visibleEntries.map((entry) => entry.path)
    const allVisibleSelected = visiblePaths.length > 0 && visiblePaths.every((entryPath) => selectedPaths.includes(entryPath))
    if (allVisibleSelected) {
      setSelectedPaths((current) => current.filter((entryPath) => !visiblePaths.includes(entryPath)))
    } else {
      setSelectedPaths((current) => [...new Set([...current, ...visiblePaths])])
    }
  }

  const sortedEntries = sortEntries(listing.entries, sort)
  const visibleEntries = filterEntries(sortedEntries, filterQuery)
  const crumbs = pathCrumbs(path)
  const selectedCount = selectedPaths.length
  const allSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selectedPaths.includes(entry.path))
  const selectedEntries = listing.entries.filter((entry) => selectedPaths.includes(entry.path))
  const selectedFileBytes = selectedEntries.reduce((total, entry) => total + (entry.type === "file" ? entry.size ?? 0 : 0), 0)
  const pasteTarget = selectedEntries.length === 1 && selectedEntries[0].type === "directory" ? selectedEntries[0].name : "this folder"

  return (
    <section className={embedded ? "flex h-[calc(100vh-9rem)] min-h-[620px] flex-col overflow-hidden rounded-lg border border-line bg-surface" : "fixed inset-0 z-20 flex flex-col bg-surface"}>
      <header className="flex flex-col gap-3 border-b border-line bg-panel px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{device.name} files</h2>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted">
            {crumbs.map((crumb, index) => (
              <span className="flex min-w-0 items-center gap-1" key={crumb.path}>
                {index > 0 && <span className="text-muted/70">/</span>}
                <button className="max-w-[9rem] truncate rounded px-1 py-0.5 text-left hover:bg-surface hover:text-ink" onClick={() => load(crumb.path)} title={crumb.path}>
                  {crumb.label}
                </button>
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex gap-1">
            <button className="btn-secondary px-2" onClick={goBack} disabled={busy || historyState.index <= 0} title="Back">
              <ChevronLeft size={17} aria-hidden="true" />
            </button>
            <button className="btn-secondary px-2" onClick={goForward} disabled={busy || historyState.index >= historyState.items.length - 1} title="Forward">
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          </div>
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

          {(listing.entries.length > 0 || filterQuery) && (
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} aria-hidden="true" />
                <input className="input min-h-10 pl-9" value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="Filter this folder" />
              </label>
              <p className="text-xs text-muted">
                {visibleEntries.length} of {listing.entries.length} items
              </p>
            </div>
          )}

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
              <p className="text-sm text-ink">
                {selectedCount} selected{selectedFileBytes ? ` · ${formatSize(selectedFileBytes)}` : ""}
              </p>
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
          {visibleEntries.length > 0 && (
            <label className="flex items-center gap-3 border-b border-line px-4 py-3 text-sm text-muted">
              <input className="h-5 w-5 rounded border-line bg-surface accent-teal-400" type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              Select visible
            </label>
          )}
          {visibleEntries.length > 0 && (
            <div className="hidden border-b border-line bg-surface/60 px-4 py-2 text-xs font-semibold uppercase text-muted md:grid md:grid-cols-[minmax(0,1fr)_120px_180px_auto]">
              <button className="flex items-center gap-1 text-left hover:text-ink" onClick={() => toggleSort("name")}>
                Name {sortIcon("name")}
              </button>
              <button className="flex items-center justify-end gap-1 text-right hover:text-ink" onClick={() => toggleSort("size")}>
                Size {sortIcon("size")}
              </button>
              <button className="flex items-center gap-1 text-left hover:text-ink" onClick={() => toggleSort("modified")}>
                Modified {sortIcon("modified")}
              </button>
              <span className="text-right">Actions</span>
            </div>
          )}
          <button className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left text-sm text-ink hover:bg-surface" onClick={() => load(listing.parent)} disabled={path === "." || path === "/"}>
            <Folder size={18} aria-hidden="true" />
            ..
          </button>
          {visibleEntries.map((entry) => (
            <div key={entry.path} className={`grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line px-4 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_120px_180px_auto] ${selectedPaths.includes(entry.path) ? "bg-surface" : ""}`}>
              <div className="flex min-w-0 items-center gap-3">
                <input className="h-5 w-5 shrink-0 rounded border-line bg-surface accent-teal-400" type="checkbox" checked={selectedPaths.includes(entry.path)} onChange={() => toggleSelection(entry)} onClick={(event) => event.stopPropagation()} />
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => entry.type === "directory" ? load(entry.path) : toggleSelection(entry)}>
                  {entry.type === "directory" ? <Folder className="shrink-0 text-teal-300" size={19} aria-hidden="true" /> : <File className="shrink-0 text-muted" size={19} aria-hidden="true" />}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{entry.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted md:hidden">
                      {entrySizeLabel(entry)}{entry.modified_at ? ` · ${formatModified(entry.modified_at)}` : ""}
                    </span>
                  </span>
                </button>
              </div>
              <span className="hidden text-right text-xs text-muted md:block">{entrySizeLabel(entry)}</span>
              <span className="hidden text-xs text-muted md:block">{formatModified(entry.modified_at)}</span>
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
          {listing.entries.length > 0 && visibleEntries.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">No matching items</p>
          )}
        </div>
      </div>
      {textPrompt && (
        <TextPromptDialog
          title={textPrompt.title}
          label={textPrompt.label}
          initialValue={textPrompt.initialValue}
          confirmLabel={textPrompt.confirmLabel}
          busy={busy}
          onSubmit={textPrompt.onSubmit}
          onCancel={() => setTextPrompt(null)}
        />
      )}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          danger={confirmDialog.danger}
          busy={busy}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
    </section>
  )
}
