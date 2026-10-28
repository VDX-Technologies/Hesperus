"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";

export const STAGE = { w: 1600, h: 1000 };

const ScaleContext = createContext(1);
export const useStageScale = () => useContext(ScaleContext);

export function Stage({
  children,
  focus = [0.5, 0.5],
  zoom = 1,
  fit = "cover",
  className = "",
}: {
  children: React.ReactNode;
  focus?: [number, number];
  zoom?: number;
  fit?: "cover" | "width";
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  let style: React.CSSProperties = { visibility: "hidden" };
  let scale = 1;
  if (box) {
    scale = (fit === "cover" ? Math.max(box.w / STAGE.w, box.h / STAGE.h) : box.w / STAGE.w) * zoom;
    const x = Math.min(0, Math.max(box.w - STAGE.w * scale, box.w / 2 - focus[0] * STAGE.w * scale));
    const y = Math.min(0, Math.max(box.h - STAGE.h * scale, box.h / 2 - focus[1] * STAGE.h * scale));
    style = { transform: `translate(${x}px, ${y}px) scale(${scale})` };
  }

  return (
    <div ref={ref} className={`relative overflow-hidden ${className}`}>
      <div className="absolute top-0 left-0 origin-top-left" style={{ ...style, width: STAGE.w, height: STAGE.h }}>
        <ScaleContext.Provider value={scale}>{children}</ScaleContext.Provider>
      </div>
    </div>
  );
}
