import { BrandMark } from "./BrandMark"
import { LanguageSwitcher } from "./LanguageSwitcher"
import { ThemeSwitcher } from "./ThemeSwitcher"

export function AuthLayout({ children, subtitle }) {
  return (
    <main className="grid min-h-screen place-items-center bg-surface px-4 py-8">
      <section className="w-full max-w-md rounded-md border border-line bg-panel p-5 shadow-lg sm:p-6">
        <div className="mb-6 flex items-start justify-between gap-3">
          <BrandMark />
          <div className="flex shrink-0 flex-col items-end gap-2">
            <LanguageSwitcher compact />
            <ThemeSwitcher />
          </div>
        </div>
        {subtitle && <p className="mb-4 text-sm text-muted">{subtitle}</p>}
        {children}
      </section>
    </main>
  )
}
