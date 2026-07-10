export function BrandMark({ compact = false, hideTextOnMobile = false }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <img className={`${compact ? "h-12 w-12" : "h-14 w-14"} shrink-0 rounded`} src="/brand/remotepanel-logo.svg" alt="" aria-hidden="true" />
      <div className={`min-w-0 leading-none ${hideTextOnMobile ? "hidden sm:block" : ""}`}>
        <p className={`${compact ? "text-lg" : "text-2xl"} truncate font-bold tracking-normal text-ink`}>
          Remote<span className="text-signal">Panel</span>
        </p>
        <p className={`${compact ? "text-[11px]" : "text-sm"} mt-1 truncate font-medium text-muted`}>One panel, all your remote systems</p>
      </div>
    </div>
  )
}
