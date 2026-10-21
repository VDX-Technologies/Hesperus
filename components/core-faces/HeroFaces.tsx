"use client";

import { useEffect, useRef, useState } from "react";
import { DefenseFace } from "./faces/DefenseFace";
import { EnterpriseFace } from "./faces/EnterpriseFace";
import { LoraFace } from "./faces/LoraFace";
import { Stage } from "./Stage";

const HOLD = 4000;

/** Where each face keeps its most readable part when cropped: desktop, then phone. */
const FACES: { el: () => React.ReactNode; focus: [number, number]; phone: [number, number] }[] = [
  { el: () => <LoraFace />, focus: [0.55, 0.3], phone: [0.3, 0.3] },
  { el: () => <DefenseFace />, focus: [0.62, 0.3], phone: [0.45, 0.5] },
  { el: () => <EnterpriseFace />, focus: [0.6, 0.3], phone: [0.82, 0.35] },
];

/** The VDX Core faces behind the login form, looping with a soft dissolve. Paused off-screen and in hidden tabs. */
export function HeroFaces({ framed = false }: { framed?: boolean } = {}) {
  const root = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [i, setI] = useState(0);
  const [visible, setVisible] = useState(true);
  const [still, setStill] = useState(false);
  const [phone, setPhone] = useState(false);
  // The first face just appears behind the title; the wipe starts with the first change.
  const [cycled, setCycled] = useState(false);

  useEffect(() => {
    const rm = matchMedia("(prefers-reduced-motion: reduce)");
    const mq = matchMedia("(max-width: 767px)");
    const sync = () => {
      setStill(rm.matches);
      setPhone(mq.matches);
    };
    sync();
    rm.addEventListener("change", sync);
    mq.addEventListener("change", sync);
    // Faces come in after first paint so the title stays the LCP.
    const t = requestAnimationFrame(() => setReady(true));

    let inView = true;
    const update = () => setVisible(inView && !document.hidden);
    const io = new IntersectionObserver(([e]) => {
      inView = e.isIntersecting;
      update();
    });
    if (root.current) io.observe(root.current);
    document.addEventListener("visibilitychange", update);
    return () => {
      cancelAnimationFrame(t);
      rm.removeEventListener("change", sync);
      mq.removeEventListener("change", sync);
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const running = ready && visible && !still;
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(() => {
      setCycled(true);
      setI((n) => (n + 1) % FACES.length);
    }, HOLD);
    return () => clearTimeout(t);
  }, [running, i]);

  const shown = still ? [0] : FACES.map((_, k) => k);

  return (
    <div ref={root} aria-hidden data-paused={!running || undefined} className={`core-faces absolute inset-0 z-0 ${framed ? "" : "brightness-[.6] saturate-[.85] md:top-[96px]"}`}>
      {ready &&
        shown.map((k) => {
          const f = FACES[k];
          return (
            <div key={k} data-active={k === i || undefined}
              data-still={(k === i && !cycled) || undefined}
              data-prev={(!still && k === (i + FACES.length - 1) % FACES.length && cycled) || undefined} className="core-face absolute inset-0">
              <Stage className="h-full w-full" focus={phone ? f.phone : f.focus} zoom={phone ? 1.15 : 1}>
                {f.el()}
              </Stage>
            </div>
          );
        })}
      {ready && !still && cycled && <span key={`scan${i}`} className="core-scan" />}
    </div>
  );
}
