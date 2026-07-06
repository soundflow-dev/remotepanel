import { useEffect, useRef, useState } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { X } from "lucide-react"

import { useI18n } from "../i18n"

function terminalUrl(deviceId) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws"
  return `${protocol}://${window.location.host}/api/ssh/${deviceId}/terminal`
}

export function SshTerminal({ device, onClose, embedded = false, panelClassName = "" }) {
  const { t } = useI18n()
  const containerRef = useRef(null)
  const socketRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const [status, setStatus] = useState("connecting")

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#070b14",
        foreground: "#dbeafe",
        cursor: "#5eead4",
        selectionBackground: "#164e63",
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    requestAnimationFrame(() => fit.fit())
    window.setTimeout(() => fit.fit(), 100)
    term.focus()
    term.writeln(t("terminal.opening", { name: device.name }))

    const socket = new WebSocket(terminalUrl(device.id))
    socketRef.current = socket
    termRef.current = term
    fitRef.current = fit

    socket.addEventListener("open", () => {
      setStatus("connected")
      term.writeln(t("terminal.websocketConnected"))
    })
    socket.addEventListener("message", (event) => {
      term.write(event.data)
    })
    socket.addEventListener("close", () => {
      setStatus("closed")
      term.writeln(`\r\n${t("terminal.sessionClosed")}`)
    })
    socket.addEventListener("error", () => {
      setStatus("error")
      term.writeln(`\r\n${t("terminal.connectionError")}`)
    })

    const disposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data)
      }
    })

    const onResize = () => requestAnimationFrame(() => fit.fit())
    window.addEventListener("resize", onResize)

    return () => {
      window.removeEventListener("resize", onResize)
      disposable.dispose()
      socket.close()
      term.dispose()
    }
  }, [device])

  return (
    <section className={embedded ? panelClassName || "flex h-[calc(100vh-7.5rem)] min-h-[720px] flex-col overflow-hidden rounded-md border border-line bg-panel" : "fixed inset-0 z-30 flex flex-col bg-surface"}>
      <header className="flex items-center justify-between gap-3 border-b border-line bg-panel px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{device.name}</h2>
          <p className="truncate text-xs text-muted">{device.username}@{device.host}:{device.port} · {t(`terminal.${status}`)}</p>
        </div>
        <button className="btn-secondary px-3" onClick={onClose} title={t("terminal.close")}>
          <X size={18} aria-hidden="true" />
          <span className="hidden sm:inline">{t("common.close")}</span>
        </button>
      </header>
      <div className="min-h-0 flex-1 p-2">
        <div ref={containerRef} className="h-full min-h-0 overflow-hidden rounded-md border border-line bg-black p-2 [&_.xterm]:h-full [&_.xterm-screen]:h-full [&_.xterm-viewport]:h-full" />
      </div>
    </section>
  )
}
