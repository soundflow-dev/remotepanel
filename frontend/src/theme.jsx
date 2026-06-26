import { createContext, useContext, useEffect, useMemo, useState } from "react"

const ThemeContext = createContext(null)
const storageKey = "remotepanel-theme"

function systemTheme() {
  if (window.matchMedia?.("(prefers-color-scheme: dark)").matches) return "dark"
  return "light"
}

function applyTheme(mode) {
  const resolved = mode === "system" ? systemTheme() : mode
  document.documentElement.dataset.theme = resolved
}

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem(storageKey) || "system")

  useEffect(() => {
    localStorage.setItem(storageKey, theme)
    applyTheme(theme)

    if (theme !== "system") return undefined

    const media = window.matchMedia?.("(prefers-color-scheme: dark)")
    const update = () => applyTheme("system")
    media?.addEventListener("change", update)
    return () => media?.removeEventListener("change", update)
  }, [theme])

  const value = useMemo(() => ({ theme, setTheme }), [theme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const value = useContext(ThemeContext)
  if (!value) throw new Error("useTheme must be used inside ThemeProvider")
  return value
}
