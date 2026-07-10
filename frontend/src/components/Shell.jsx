import { LogOut } from "lucide-react"

import { useI18n } from "../i18n"
import { BrandMark } from "./BrandMark"
import { ThemeSwitcher } from "./ThemeSwitcher"

export function Shell({ user, onLogout, topAction, navigationAction, children }) {
  const { t } = useI18n()

  return (
    <div className="min-h-screen bg-surface">
      <div>
        <header className="sticky top-0 z-10 border-b border-line bg-panel/95 backdrop-blur">
          <div className="flex min-h-14 items-center gap-2 px-3 py-2 sm:px-4 lg:grid lg:grid-cols-[300px_minmax(0,1fr)_auto] lg:gap-3 xl:grid-cols-[320px_minmax(0,1fr)_auto]">
            <div className="min-w-0 shrink-0">
              <BrandMark compact hideTextOnMobile />
            </div>
            <div className="hidden min-w-0 justify-center lg:flex">{navigationAction}</div>
            <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
              <span className="hidden max-w-32 truncate text-xs font-semibold text-muted md:inline">{user?.name}</span>
              <ThemeSwitcher />
              {topAction}
              <button className="grid h-10 w-10 shrink-0 place-items-center rounded border border-rose-400/40 bg-rose-500/10 text-rose-500 shadow-sm transition hover:bg-rose-500/15" onClick={onLogout} title={t("logout")} aria-label={t("logout")}>
                <LogOut size={17} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="border-t border-line/70 px-3 py-2 lg:hidden">
            <div className="-mx-1 overflow-x-auto px-1">
              <div className="w-max">{navigationAction}</div>
            </div>
          </div>
        </header>
        <main className="px-3 py-2 sm:px-4 lg:px-5">{children}</main>
      </div>
    </div>
  )
}
