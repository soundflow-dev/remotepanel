import { LogOut } from "lucide-react"

import { useI18n } from "../i18n"
import { BrandMark } from "./BrandMark"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { ThemeSwitcher } from "./ThemeSwitcher"

export function Shell({ user, onLogout, topAction, children }) {
  const { t } = useI18n()

  return (
    <div className="min-h-screen bg-surface">
      <div>
        <header className="sticky top-0 z-10 border-b border-line bg-panel/95 backdrop-blur">
          <div className="flex h-14 items-center justify-between gap-3 px-4 sm:px-6">
            <BrandMark compact />
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden max-w-32 truncate text-xs font-semibold text-muted md:inline">{user?.name}</span>
              <LanguageSwitcher compact />
              {topAction}
              <ThemeSwitcher />
              <button className="min-h-10 rounded border border-rose-400/40 bg-rose-500/10 px-3 text-sm font-semibold text-rose-600 shadow-sm transition hover:bg-rose-500/15" onClick={onLogout} title={t("logout")}>
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
