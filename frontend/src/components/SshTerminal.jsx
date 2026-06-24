import { useEffect, useRef, useState } from "react"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal as XTerm } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"
import { X } from "lucide-react"

function terminalUrl(deviceId) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws"
  return `${protocol}://${window.location.host}/api/ssh/${deviceId}/terminal`
}

export function SshTerminal({ device, onClose }) {
  const containerRef = useRef(null)
  const socketRef = useRef(null)
  const termRef = useRef(null)
  const fitRef = useRef(null)
  const [status, setStatus] = useState("Connecting")

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
    fit.fit()
    term.focus()
    term.writeln(`Opening SSH terminal for ${device.name}...`)

    const socket = new WebSocket(terminalUrl(device.id))
    socketRef.current = socket
    termRef.current = term
    fitRef.current = fit

    socket.addEventListener("open", () => {
      setStatus("Connected")
      term.writeln("WebSocket connected.")
    })
    socket.addEventListener("message", (event) => {
      term.write(event.data)
    })
    socket.addEventListener("close", () => {
      setStatus("Closed")
      term.writeln("\r\nSession closed.")
    })
    socket.addEventListener("error", () => {
      setStatus("Error")
      term.writeln("\r\nTerminal connection error.")
    })

    const disposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data)
      }
    })

    const onResize = () => fit.fit()
    window.addEventListener("resize", onResize)

    return () => {
      window.removeEventListener("resize", onResize)
      disposable.dispose()
      socket.close()
      term.dispose()
    }
  }, [device])

  return (
    <section className="fixed inset-0 z-30 flex flex-col bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-panel px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{device.name}</h2>
          <p className="truncate text-xs text-muted">{device.username}@{device.host}:{device.port} · {status}</p>
        </div>
        <button className="btn-secondary px-3" onClick={onClose} title="Close terminal">
          <X size={18} aria-hidden="true" />
          <span className="hidden sm:inline">Close</span>
        </button>
      </header>
      <div className="min-h-0 flex-1 p-2 sm:p-3">
        <div ref={containerRef} className="h-full overflow-hidden rounded-md border border-line bg-black p-2" />
      </div>
    </section>
  )
}
