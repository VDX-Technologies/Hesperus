/** The VDX Core app frame shared by every face: same bar, same navigation. Only the content changes. */
export function CoreShell({
  workspace,
  nav,
  active = 0,
  alerts,
  children,
}: {
  workspace: string;
  nav: string[];
  active?: number;
  alerts?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col bg-ink-900 text-frost">
      <header className="flex h-[68px] shrink-0 items-center gap-10 border-b border-line-soft px-[72px] text-[16px]">
        <span className="flex items-center gap-3">
          <span aria-hidden className="block h-[26px] w-[24px] bg-current [mask:url(/brand/vdx-mark.png)_center/contain_no-repeat]" />
          <span>
            <b className="font-semibold">VDX</b> Core
          </span>
        </span>
        <span className="text-mist">{workspace}</span>
        <nav className="flex items-center gap-8">
          {nav.map((n, i) => (
            <span key={n} className={`flex items-center gap-2 ${i === active ? "text-white" : "text-mist"}`}>
              {n}
              {n === "Alerts" && !!alerts && (
                <span className="rounded-full bg-[#ff5a5f] px-1.5 text-[11px] leading-[17px] text-white">{alerts}</span>
              )}
            </span>
          ))}
        </nav>
        <span className="ml-auto flex items-center gap-8 text-[14px]">
          <span>
            EN <span className="ml-2 text-dim">IT</span>
          </span>
          <span className="text-mist">Sign out</span>
        </span>
      </header>
      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
