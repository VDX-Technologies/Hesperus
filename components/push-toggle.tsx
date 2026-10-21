"use client";
import { useEffect, useState } from "react";
import { subscribePush, unsubscribePush, type PushKeys } from "@/app/o/[slug]/alerts/push-actions";

type State = "loading" | "unsupported" | "install" | "denied" | "off" | "on";

const KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

function urlBase64ToUint8Array(base64: string) {
  const raw = atob((base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Alarm notifications on this device (PWA web push). iPhone/iPad need the app on the Home Screen first. */
export function PushToggle({
  slug,
  labels,
}: {
  slug: string;
  labels: { title: string; on: string; off: string; enable: string; disable: string; denied: string; unsupported: string; install: string };
}) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !KEY)
        return setState(ios && !standalone ? "install" : "unsupported");
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function toggle() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (state === "on") {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await unsubscribePush(slug, sub.endpoint);
          await sub.unsubscribe();
        }
        setState("off");
      } else {
        if ((await Notification.requestPermission()) !== "granted") return setState("denied");
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(KEY) });
        await subscribePush(slug, sub.toJSON() as PushKeys, navigator.userAgent);
        setState("on");
      }
    } finally {
      setBusy(false);
    }
  }

  if (state === "loading") return null;
  const note = { unsupported: labels.unsupported, install: labels.install, denied: labels.denied, on: labels.on, off: labels.off }[state];
  return (
    <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ice">{labels.title}</div>
        <p className="mt-0.5 text-xs text-mist">{note}</p>
      </div>
      {(state === "on" || state === "off") && (
        <button type="button" onClick={toggle} disabled={busy} className={`btn shrink-0 text-xs ${state === "off" ? "border-frost" : ""}`}>
          {state === "on" ? labels.disable : labels.enable}
        </button>
      )}
    </div>
  );
}
