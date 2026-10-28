"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const url = `${pathname}?${search}`;
  const [startedOn, setStartedOn] = useState<string | null>(null);
  const active = startedOn === url;
  const busy = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const clearBusy = () => {
    clearTimeout(timer.current);
    busy.current?.removeAttribute("data-busy");
    busy.current = null;
  };

  useEffect(clearBusy, [url]);

  useEffect(() => {
    const stop = () => {
      clearBusy();
      setStartedOn(null);
    };
    const start = (btn?: HTMLElement | null) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(stop, 15_000);
      if (btn) {
        btn.setAttribute("data-busy", "");
        busy.current = btn;
      }
      setStartedOn(`${location.pathname}?${location.search.slice(1)}`);
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element).closest?.("a");
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      start();
    };
    const onSubmit = (e: SubmitEvent) => {
      if (!e.defaultPrevented) start(e.submitter as HTMLElement | null);
    };
    const onReset = () => stop();
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit);
    document.addEventListener("reset", onReset, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit);
      document.removeEventListener("reset", onReset, true);
    };
  }, []);

  return <div aria-hidden className={`nav-progress ${active ? "is-active" : ""}`} />;
}
