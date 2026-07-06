import { useEffect, useState } from "react"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ClipboardList, ClipboardPaste, Copy, Download, File, Folder, FolderPlus, MoveRight, Pencil, RefreshCw, Search, Trash2, X } from "lucide-react"

import { api } from "../api/client"
import { ConfirmDialog, TextPromptDialog } from "./ModalDialog"
import { plural, useI18n } from "../i18n"

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

function entrySizeLabel(entry, t) {
  if (entry.type === "directory") return t("files.folderLabel")
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
  const isAbsolute = currentPath.startsWith("/")
  const parts = currentPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean)
  return [
    { label: "Root", path: "." },
    ...parts.map((part, index) => ({
      label: part,
      path: `${isAbsolute ? "/" : ""}${parts.slice(0, index + 1).join("/")}`,
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

export function FileExplorer({ device, targetType = "device", targetLabel, onClose, onRootBack, clipboard, onClipboardSet, onClipboardClear, onJobCreated, onQueueTransfer, onDestinationContextChange, transferMode = "balanced", refreshSignal = 0, embedded = false, panelClassName = "" }) {
  const { t } = useI18n()
  const targetDisplayName = targetLabel || device.name
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
  const [contextMenu, setContextMenu] = useState(null)

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

  useEffect(() => {
    if (refreshSignal <= 0) return
    load(path, { recordHistory: false, keepMessage: true })
  }, [refreshSignal])

  useEffect(() => {
    if (!contextMenu) return undefined
    function closeMenu() {
      setContextMenu(null)
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") closeMenu()
    }
    window.addEventListener("click", closeMenu)
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      window.removeEventListener("click", closeMenu)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!onDestinationContextChange) return undefined
    onDestinationContextChange({
      targetType,
      deviceId: device.id,
      deviceName: targetDisplayName,
      path,
      label: path === "." ? t("files.root") : path,
    })
    return undefined
  }, [device.id, onDestinationContextChange, path, targetDisplayName, targetType, t])

  function goBack() {
    if (historyState.index <= 0) {
      if (onRootBack) onRootBack()
      return
    }
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
      title: t("files.createFolder"),
      label: t("files.folderName"),
      initialValue: "",
      confirmLabel: t("files.createFolder"),
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
      title: t("files.renameItem"),
      label: t("files.newName"),
      initialValue: entry.name,
      confirmLabel: t("common.rename"),
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
      title: t("files.deleteItem"),
      message: t("files.deleteItemMessage", { name: entry.name }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: () => deleteEntryConfirmed(entry),
    })
  }

  async function deleteEntryConfirmed(entry) {
    setBusy(true)
    setMessage("")
    try {
      const result = await api.deletePath(targetType, device.id, entry.path)
      setMessage(t("files.deleted", { path: result.path ?? entry.name }))
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
      title: t("files.deleteSelected"),
      message: t("files.deleteSelectedMessage", { count: selectedPaths.length, plural: plural(selectedPaths.length) }),
      confirmLabel: t("common.delete"),
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
          throw new Error(t("files.failedDeleting", { path: selectedPath, message: err.message }))
        }
      }
      setMessage(t("files.selectedDeleted"))
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

  function copyPaths(action, sourcePaths) {
    if (sourcePaths.length === 0) return
    onClipboardSet({
      action,
      sourceTargetType: targetType,
      sourceDeviceId: device.id,
      sourceDeviceName: targetDisplayName,
      sourcePaths,
    })
    setMessage(t("files.readyToAction", { count: sourcePaths.length, plural: plural(sourcePaths.length), action: action === "move" ? t("common.move").toLowerCase() : t("common.copy").toLowerCase() }))
  }

  function copySelected(action) {
    if (selectedPaths.length === 0) return
    copyPaths(action, selectedPaths)
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
        transfer_profile: transferMode,
      })
      await load(path)
      onClipboardClear()
      if (onJobCreated) {
        onJobCreated(result)
      }
      setMessage(t("files.jobStarted", { action: result.action === "move" ? t("common.move") : t("common.copy"), count: result.source_paths.length, plural: plural(result.source_paths.length), target: selectedDirectory ? selectedDirectory.name : t("files.pasteThisFolder") }))
    } catch (err) {
      setMessage(err.message)
    } finally {
      setBusy(false)
    }
  }

  function addClipboardToQueue() {
    if (!clipboard || !onQueueTransfer) return
    const selectedEntries = sortedEntries.filter((entry) => selectedPaths.includes(entry.path))
    const selectedDirectory = selectedEntries.length === 1 && selectedEntries[0].type === "directory" ? selectedEntries[0] : null
    const pasteDestination = selectedDirectory ? selectedDirectory.path : path
    onQueueTransfer({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action: clipboard.action,
      sourceTargetType: clipboard.sourceTargetType ?? "device",
      destinationTargetType: targetType,
      sourceDeviceId: clipboard.sourceDeviceId,
      destinationDeviceId: device.id,
      sourceDeviceName: clipboard.sourceDeviceName,
      destinationDeviceName: targetDisplayName,
      sourcePaths: clipboard.sourcePaths,
      destinationPath: pasteDestination,
      destinationLabel: selectedDirectory ? selectedDirectory.name : t("files.pasteThisFolder"),
    })
    onClipboardClear()
    setSelectedPaths([])
    setMessage(t("files.addedToQueue", { count: clipboard.sourcePaths.length, plural: plural(clipboard.sourcePaths.length), target: selectedDirectory ? selectedDirectory.name : t("files.pasteThisFolder") }))
  }

  function queuePaths(sourcePaths, destinationPath = path, destinationLabel = path === "." ? t("files.root") : path) {
    if (!onQueueTransfer || sourcePaths.length === 0) return
    onQueueTransfer({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      action: "copy",
      sourceTargetType: targetType,
      destinationTargetType: targetType,
      sourceDeviceId: device.id,
      destinationDeviceId: device.id,
      sourceDeviceName: targetDisplayName,
      destinationDeviceName: targetDisplayName,
      sourcePaths,
      destinationPath,
      destinationLabel,
    })
    setMessage(t("files.addedToQueue", { count: sourcePaths.length, plural: plural(sourcePaths.length), target: destinationLabel }))
  }

  function queueSelected() {
    if (selectedPaths.length === 0) return
    queuePaths(selectedPaths)
    setSelectedPaths([])
  }

  function contextPaths(entry) {
    if (!entry) return selectedPaths
    return selectedPaths.includes(entry.path) ? selectedPaths : [entry.path]
  }

  function openEntryContextMenu(event, entry) {
    event.preventDefault()
    event.stopPropagation()
    const paths = contextPaths(entry)
    if (!selectedPaths.includes(entry.path)) {
      setSelectedPaths([entry.path])
    }
    setContextMenu({ x: event.clientX, y: event.clientY, paths })
  }

  function openFolderContextMenu(event) {
    if (event.target.closest("[data-file-row]")) return
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, paths: selectedPaths })
  }

  function runContextAction(action) {
    const paths = contextMenu?.paths ?? []
    setContextMenu(null)
    if (action === "paste") {
      pasteHere()
      return
    }
    if (action === "queue") {
      if (paths.length > 0) {
        queuePaths(paths)
      } else {
        addClipboardToQueue()
      }
      return
    }
    if (paths.length > 0) {
      copyPaths(action, paths)
      setSelectedPaths([])
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
  const pasteTarget = selectedEntries.length === 1 && selectedEntries[0].type === "directory" ? selectedEntries[0].name : t("files.pasteThisFolder")

  return (
    <section className={embedded ? panelClassName || "flex h-[calc(100vh-7.5rem)] min-h-[600px] flex-col overflow-hidden rounded-md border border-line bg-panel" : "fixed inset-0 z-20 flex flex-col bg-surface"}>
      <header className="flex flex-col gap-3 border-b border-line bg-panel px-3 py-2.5 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{t("files.title", { name: targetDisplayName })}</h2>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted">
            {crumbs.map((crumb, index) => (
              <span className="flex min-w-0 items-center gap-1" key={crumb.path}>
                {index > 0 && <span className="text-muted/70">/</span>}
                <button className="max-w-[9rem] truncate rounded px-1 py-0.5 text-left hover:bg-surface hover:text-ink" onClick={() => load(crumb.path)} title={crumb.path}>
                  {crumb.path === "." ? t("files.root") : crumb.label}
                </button>
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="flex gap-1">
            <button className="btn-secondary px-2" onClick={goBack} disabled={busy || (historyState.index <= 0 && !onRootBack)} title={t("common.back")}>
              <ChevronLeft size={17} aria-hidden="true" />
            </button>
            <button className="btn-secondary px-2" onClick={goForward} disabled={busy || historyState.index >= historyState.items.length - 1} title={t("common.forward")}>
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          </div>
          <button className="btn-secondary px-3" onClick={() => load(path)} disabled={busy} title={t("common.refresh")}>
            <RefreshCw size={17} aria-hidden="true" />
            <span className="hidden sm:inline">{t("common.refresh")}</span>
          </button>
          <button className="btn-secondary px-3" onClick={createFolder} title={t("files.createFolder")}>
            <FolderPlus size={17} aria-hidden="true" />
            <span className="hidden sm:inline">{t("common.folder")}</span>
          </button>
          <button className="btn-secondary px-3" onClick={onClose} title={t("files.closeFiles")}>
            <X size={17} aria-hidden="true" />
            <span className="hidden sm:inline">{t("common.close")}</span>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto" onContextMenu={openFolderContextMenu}>
        <div className="sticky top-0 z-10 border-b border-line bg-panel/95 p-3 backdrop-blur">
          {message && <p className="mb-3 rounded-md border border-line bg-panel px-3 py-2.5 text-sm text-ink">{message}</p>}

          {(listing.entries.length > 0 || filterQuery) && (
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" size={16} aria-hidden="true" />
                <input className="field min-h-9 !pl-10" value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder={t("files.filterPlaceholder")} />
              </label>
              <p className="text-xs text-muted">
                {t("files.itemCount", { visible: visibleEntries.length, total: listing.entries.length })}
              </p>
            </div>
          )}

          {clipboard && (
            <div className="mb-3 flex flex-col gap-3 rounded-md border border-signal/40 bg-signal/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink">
                {t("files.clipboardSummary", { action: clipboard.action === "move" ? t("common.move") : t("common.copy"), count: clipboard.sourcePaths.length, plural: plural(clipboard.sourcePaths.length), source: clipboard.sourceDeviceName })}
              </p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-primary min-h-9 px-3" onClick={pasteHere} disabled={busy}>
                  <ClipboardPaste size={15} aria-hidden="true" />
                  {t("files.pasteTo", { target: pasteTarget })}
                </button>
                {onQueueTransfer && (
                  <button className="btn-secondary min-h-9 px-3" onClick={addClipboardToQueue} disabled={busy}>
                    <ClipboardList size={15} aria-hidden="true" />
                    {t("files.queue")}
                  </button>
                )}
                <button className="btn-secondary min-h-9 px-3" onClick={onClipboardClear}>
                  {t("files.clear")}
                </button>
              </div>
            </div>
          )}

          {selectedCount > 0 && (
            <div className="flex flex-col gap-3 rounded-md border border-line bg-panel px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-ink">
                {t("files.selected", { count: selectedCount, plural: plural(selectedCount) })}{selectedFileBytes ? ` · ${formatSize(selectedFileBytes)}` : ""}
              </p>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary min-h-9 px-3" onClick={() => copySelected("copy")} disabled={busy}>
                  <Copy size={15} aria-hidden="true" />
                  {t("common.copy")}
                </button>
                {onQueueTransfer && (
                  <button className="btn-secondary min-h-9 px-3" onClick={queueSelected} disabled={busy}>
                    <ClipboardList size={15} aria-hidden="true" />
                    {t("files.queue")}
                  </button>
                )}
                <button className="btn-secondary min-h-9 px-3" onClick={() => copySelected("move")} disabled={busy}>
                  <MoveRight size={15} aria-hidden="true" />
                  {t("common.move")}
                </button>
                <button className="btn-danger min-h-9 px-3" onClick={deleteSelected} disabled={busy}>
                  <Trash2 size={15} aria-hidden="true" />
                  {t("common.delete")}
                </button>
                <button className="btn-secondary min-h-9 px-3" onClick={() => setSelectedPaths([])}>
                  {t("files.clear")}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="m-3 overflow-hidden rounded-md border border-line bg-panel">
          {visibleEntries.length > 0 && (
            <label className="flex items-center gap-3 border-b border-line px-3 py-2.5 text-sm text-muted">
              <input className="h-5 w-5 rounded border-line bg-surface accent-signal" type="checkbox" checked={allSelected} onChange={toggleSelectAll} />
              {t("files.selectVisible")}
            </label>
          )}
          {visibleEntries.length > 0 && (
            <div className="hidden border-b border-line bg-surface/60 px-3 py-2 text-[11px] font-semibold uppercase text-muted md:grid md:grid-cols-[minmax(12rem,1fr)_74px_116px_176px]">
              <button className="flex items-center gap-1 text-left hover:text-ink" onClick={() => toggleSort("name")}>
                {t("common.name")} {sortIcon("name")}
              </button>
              <button className="flex items-center justify-end gap-1 text-right hover:text-ink" onClick={() => toggleSort("size")}>
                {t("common.size")} {sortIcon("size")}
              </button>
              <button className="flex items-center gap-1 text-left hover:text-ink" onClick={() => toggleSort("modified")}>
                {t("common.modified")} {sortIcon("modified")}
              </button>
              <span className="text-right">{t("common.actions")}</span>
            </div>
          )}
          <button className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left text-sm text-ink hover:bg-surface" onClick={() => load(listing.parent)} disabled={path === "." || path === "/"}>
            <Folder size={18} aria-hidden="true" />
            ..
          </button>
          {visibleEntries.map((entry) => (
            <div key={entry.path} data-file-row className={`grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(12rem,1fr)_74px_116px_176px] ${selectedPaths.includes(entry.path) ? "bg-surface" : ""}`} onContextMenu={(event) => openEntryContextMenu(event, entry)}>
              <div className="flex min-w-0 items-center gap-3">
                <input className="h-5 w-5 shrink-0 rounded border-line bg-surface accent-signal" type="checkbox" checked={selectedPaths.includes(entry.path)} onChange={() => toggleSelection(entry)} onClick={(event) => event.stopPropagation()} />
                <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => entry.type === "directory" ? load(entry.path) : toggleSelection(entry)}>
                  {entry.type === "directory" ? <Folder className="shrink-0 text-signal" size={19} aria-hidden="true" /> : <File className="shrink-0 text-muted" size={19} aria-hidden="true" />}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{entry.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted md:hidden">
                      {entrySizeLabel(entry, t)}{entry.modified_at ? ` · ${formatModified(entry.modified_at)}` : ""}
                    </span>
                  </span>
                </button>
              </div>
              <span className="hidden text-right text-xs text-muted md:block">{entrySizeLabel(entry, t)}</span>
              <span className="hidden text-xs text-muted md:block">{formatModified(entry.modified_at)}</span>
              <div className="flex flex-wrap justify-end gap-1.5">
                {entry.type === "file" && (
                  <button className="btn-secondary min-h-9 px-2" onClick={() => downloadEntry(entry)} title={t("files.download")}>
                    <Download size={15} aria-hidden="true" />
                  </button>
                )}
                <button className="btn-secondary min-h-9 px-2" onClick={() => copyPaths("copy", [entry.path])} title={t("common.copy")}>
                  <Copy size={15} aria-hidden="true" />
                  <span className="sr-only">{t("common.copy")}</span>
                </button>
                {onQueueTransfer && (
                  <button className="btn-secondary min-h-9 px-2" onClick={() => queuePaths([entry.path])} title={t("files.queue")}>
                    <ClipboardList size={15} aria-hidden="true" />
                    <span className="sr-only">{t("files.queue")}</span>
                  </button>
                )}
                <button className="btn-secondary min-h-9 px-2" onClick={() => renameEntry(entry)} title={t("common.rename")}>
                  <Pencil size={15} aria-hidden="true" />
                  <span className="sr-only">{t("common.rename")}</span>
                </button>
                <button className="btn-danger min-h-9 px-2" onClick={() => deleteEntry(entry)} title={t("common.delete")}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
          {listing.entries.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">{t("files.empty")}</p>
          )}
          {listing.entries.length > 0 && visibleEntries.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-muted">{t("files.noMatches")}</p>
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
      {contextMenu && (
        <div className="fixed z-[80] min-w-44 overflow-hidden rounded-md border border-line bg-panel py-1 shadow-xl" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          {contextMenu.paths.length > 0 && (
            <>
              <button className="block w-full px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface" type="button" onClick={() => runContextAction("copy")}>{t("common.copy")}</button>
              <button className="block w-full px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface" type="button" onClick={() => runContextAction("move")}>{t("common.move")}</button>
              {onQueueTransfer && <button className="block w-full px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface" type="button" onClick={() => runContextAction("queue")}>{t("files.queue")}</button>}
            </>
          )}
          {clipboard && <button className="block w-full border-t border-line px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface" type="button" onClick={() => runContextAction("paste")}>{t("files.pasteTo", { target: pasteTarget })}</button>}
          {clipboard && onQueueTransfer && <button className="block w-full px-3 py-2 text-left text-sm font-semibold text-ink hover:bg-surface" type="button" onClick={() => runContextAction("queue")}>{t("files.queue")}</button>}
        </div>
      )}
    </section>
  )
}
