import { useEffect, useState } from "react"

export function ConfirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, busy = false, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-panel p-4 shadow-2xl">
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        <p className="mt-2 text-sm text-muted">{message}</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm} disabled={busy}>
            {busy ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function TextPromptDialog({ title, label, initialValue = "", confirmLabel = "Save", cancelLabel = "Cancel", busy = false, onSubmit, onCancel }) {
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState("")

  useEffect(() => {
    setValue(initialValue)
    setError("")
  }, [initialValue])

  function submit(event) {
    event.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) {
      setError(`${label} is required.`)
      return
    }
    onSubmit(trimmed)
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <form className="w-full max-w-md rounded-lg border border-line bg-panel p-4 shadow-2xl" onSubmit={submit} noValidate>
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        <label className="label mt-4 block" htmlFor="prompt-value">{label}</label>
        <input className="field mt-1" id="prompt-value" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy ? "Working..." : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}
