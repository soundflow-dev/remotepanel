import { useEffect, useState } from "react"

import { useI18n } from "../i18n"

export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, danger = false, busy = false, onConfirm, onCancel }) {
  const { t } = useI18n()

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-3">
      <div className="w-full max-w-md rounded-md border border-line bg-panel p-3 shadow-2xl">
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        <p className="mt-2 text-sm text-muted">{message}</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t("common.cancel")}
          </button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm} disabled={busy}>
            {busy ? t("common.working") : confirmLabel ?? t("common.confirm")}
          </button>
        </div>
      </div>
    </div>
  )
}

export function TextPromptDialog({ title, label, initialValue = "", confirmLabel, cancelLabel, busy = false, onSubmit, onCancel }) {
  const { t } = useI18n()
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
      setError(t("common.requiredField", { label }))
      return
    }
    onSubmit(trimmed)
  }

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-3">
      <form className="w-full max-w-md rounded-md border border-line bg-panel p-3 shadow-2xl" onSubmit={submit} noValidate>
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        <label className="label mt-4 block" htmlFor="prompt-value">{label}</label>
        <input className="field mt-1" id="prompt-value" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
        {error && <p className="mt-2 text-sm text-red-300">{error}</p>}
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t("common.cancel")}
          </button>
          <button className="btn-primary" disabled={busy}>
            {busy ? t("common.working") : confirmLabel ?? t("common.save")}
          </button>
        </div>
      </form>
    </div>
  )
}
