import { LogOut } from "lucide-react"

import { useI18n } from "../i18n"
import { BrandMark } from "./BrandMark"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { ThemeSwitcher } from "./ThemeSwitcher"

export function Shell({ user, onLogout, topAction, navigationAction, children }) {
  const { t } = useI18n()

  return (
    <div className="min-h-screen bg-surface">
      <div>
        <header className="sticky top-0 z-10 border-b border-line bg-panel/95 backdrop-blur">
          <div className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 sm:px-6 lg:grid-cols-[300px_minmax(0,1fr)_auto] xl:grid-cols-[320px_minmax(0,1fr)_auto]">
            <BrandMark compact />
            <div className="min-w-0">{navigationAction}</div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden max-w-32 truncate text-xs font-semibold text-muted md:inline">{user?.name}</span>
              <LanguageSwitcher compact />
              <ThemeSwitcher />
              {topAction}
              <button className="inline-flex min-h-10 items-center gap-2 rounded border border-rose-400/40 bg-rose-500/10 px-3 text-sm font-semibold text-rose-500 shadow-sm transition hover:bg-rose-500/15" onClick={onLogout} title={t("logout")}>
                <LogOut size={17} aria-hidden="true" />
                <span className="hidden sm:inline">{t("logout")}</span>
              </button>
            </div>
          </div>
        </header>
        <main className="px-3 py-2 sm:px-4 lg:px-5">{children}</main>
      </div>
    </div>
  )
}
