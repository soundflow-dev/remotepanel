import { LogOut, ServerCog } from "lucide-react"

import { useI18n } from "../i18n"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { ThemeSwitcher } from "./ThemeSwitcher"

export function Shell({ user, onLogout, children }) {
  const { t } = useI18n()

  return (
    <div className="min-h-screen bg-surface">
      <div>
        <header className="sticky top-0 z-10 border-b border-line bg-panel/95 backdrop-blur">
          <div className="flex h-14 items-center justify-between gap-3 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded bg-signal text-white">
                <ServerCog size={20} aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">RemotePanel</p>
                <p className="truncate text-xs text-muted">{user?.name}</p>
              </div>
            </div>
            <p className="pointer-events-none hidden select-none text-sm font-semibold text-muted/40 lg:block">One panel, all your remote systems</p>
            <div className="flex shrink-0 items-center gap-2">
              <LanguageSwitcher compact />
              <ThemeSwitcher />
              <button className="btn-secondary px-3" onClick={onLogout} title={t("logout")}>
                <LogOut size={17} aria-hidden="true" />
                <span className="hidden sm:inline">{t("logout")}</span>
              </button>
            </div>
          </div>
        </header>
        <main className="px-3 py-4 sm:px-4 lg:px-5">{children}</main>
      </div>
    </div>
  )
}
