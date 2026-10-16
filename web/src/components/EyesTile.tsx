import { useEffect, useRef, useState } from "react";
import type { EyesScene } from "../three/EyesScene";
import { afterHandoff } from "../lib/handoff";

/**
 * The violet tile with the 3D mascot. `shield` (0..1) slides the glasses on.
 * Falls back to the flat logo when WebGL is missing.
 * `defer` (ms) holds the 3D scene back while a tap may still be opening a wallet app (lib/handoff.ts):
 * the tile shows plain violet until then.
 */
export function EyesTile({
  shield = 0,
  className = "",
  compact = false,
  defer = 0,
  onScene,
}: {
  shield?: number;
  className?: string;
  compact?: boolean;
  defer?: number;
  onScene?: (s: EyesScene | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<EyesScene | null>(null);
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    let dead = false;
    const build = () => {
      if (dead) return;
      const canvas = document.createElement("canvas");
      const ok = !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
      if (!ok) {
        setFallback(true);
        return;
      }
      import("../three/EyesScene").then(({ EyesScene }) => {
        if (dead || !host.current) return;
        try {
          scene.current = new EyesScene(host.current, { transparent: true, compact, shielded: shield > 0.5 });
          onScene?.(scene.current);
        } catch {
          setFallback(true);
        }
      });
    };
    const cancel = afterHandoff(build, defer, document);
    return () => {
      dead = true;
      cancel();
      scene.current?.dispose();
      scene.current = null;
      onScene?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, defer]);

  useEffect(() => {
    scene.current?.setShield(shield);
  }, [shield]);

  return (
    <div className={`eyes-tile ${className}`}>
      {fallback ? (
        <img src="/logo-600.webp" alt="VisionSwap mascot: two eyes peeking over sunglasses" />
      ) : (
        <div ref={host} className="eyes-host" aria-hidden="true" />
      )}
    </div>
  );
}
