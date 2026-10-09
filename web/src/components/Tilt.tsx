import { useRef, type CSSProperties, type ReactNode } from "react";

/** Leans its content toward the pointer, like a card held in the hand. */
export function Tilt({
  children,
  className = "",
  style,
  max = 8,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  max?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const set = (rx: number, ry: number, gx: number, gy: number) => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const n = el.current;
      if (!n) return;
      n.style.setProperty("--rx", `${rx}deg`);
      n.style.setProperty("--ry", `${ry}deg`);
      n.style.setProperty("--gx", `${gx}%`);
      n.style.setProperty("--gy", `${gy}%`);
    });
  };

  return (
    <div
      ref={el}
      className={`tilt ${className}`}
      style={style}
      onPointerMove={(e) => {
        if (reduced || e.pointerType === "touch") return;
        const r = e.currentTarget.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width;
        const y = (e.clientY - r.top) / r.height;
        set((0.5 - y) * max, (x - 0.5) * max, x * 100, y * 100);
      }}
      onPointerLeave={() => set(0, 0, 50, 30)}
    >
      {children}
    </div>
  );
}
