export function noise(i: number, seed = 0) {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

export function sun(t: number) {
  const d = ((t % 1) + 1) % 1;
  return d < 0.27 || d > 0.79 ? 0 : Math.sin((Math.PI * (d - 0.27)) / 0.52);
}

export function series(n: number, end: number, f: (t: number, i: number) => number) {
  return Array.from({ length: n }, (_, i) => f(end - 1 + (i + 1) / n, i));
}

export function hourLabels(end: number, count = 6) {
  return Array.from({ length: count }, (_, i) => {
    const t = (((end - 1 + (i + 0.5) / count) % 1) + 1) % 1;
    const mins = Math.round((t * 24 * 60) / 15) * 15;
    const h = Math.floor(mins / 60) % 24;
    const m = mins % 60;
    return `${String(h % 12 || 12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  });
}
