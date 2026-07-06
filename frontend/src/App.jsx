import React, { useEffect, useState } from "react"
import { createRoot } from "react-dom/client"

import "./styles.css"
import { api } from "./api/client"
import { Shell } from "./components/Shell"
import { LanguageProvider, useI18n } from "./i18n"
import { DashboardPage } from "./pages/DashboardPage"
import { LoginPage } from "./pages/LoginPage"
import { SetupPage } from "./pages/SetupPage"
import { ThemeProvider } from "./theme"

export default function App() {
  const { t } = useI18n()
  const [loading, setLoading] = useState(true)
  const [setupStatus, setSetupStatus] = useState(null)
  const [user, setUser] = useState(null)
  const [topAction, setTopAction] = useState(null)
  const [navigationAction, setNavigationAction] = useState(null)

  useEffect(() => {
    async function boot() {
      const status = await api.setupStatus()
      setSetupStatus(status)
      if (!status.setup_required) {
        try {
          setUser(await api.me())
        } catch {
          setUser(null)
        }
      }
      setLoading(false)
    }
    boot().catch(() => setLoading(false))
  }, [])

  async function logout() {
    await api.logout()
    setUser(null)
  }

  if (loading) {
    return <main className="grid min-h-screen place-items-center bg-surface text-sm text-muted">{t("loading")}</main>
  }

  if (setupStatus?.setup_required) {
    return <SetupPage status={setupStatus} onReady={(createdUser) => {
      setSetupStatus({ ...setupStatus, setup_required: false })
      setUser(createdUser)
    }} />
  }

  if (!user) {
    return <LoginPage onReady={setUser} />
  }

  return (
    <Shell user={user} onLogout={logout} topAction={topAction} navigationAction={navigationAction}>
      <DashboardPage setTopAction={setTopAction} setNavigationAction={setNavigationAction} />
    </Shell>
  )
}

createRoot(document.getElementById("root")).render(
  <ThemeProvider>
    <LanguageProvider>
      <App />
    </LanguageProvider>
  </ThemeProvider>,
)
