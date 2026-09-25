import { useEffect, useRef, useState, type ReactNode } from 'react';

export function useCountUp(target: number, ms = 250) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const cur = a + (target - a) * (1 - (1 - p) ** 3);
      from.current = cur;
      setV(cur);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export const Card = ({ className = '', children }: { className?: string; children: ReactNode }) => (
  <div className={`rounded-xl bg-surface ring-1 ring-line/70 ${className}`}>{children}</div>
);

// Animated number. `f` formats the in-flight value so it rolls like an odometer.
export function Num({ v, f, className = '', color }: { v: number; f: (n: number) => string; className?: string; color?: string }) {
  const n = useCountUp(Number.isFinite(v) ? v : 0, 450);
  return <span className={`tnum ${className}`} style={{ color }}>{f(n)}</span>;
}
