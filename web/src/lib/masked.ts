import { useEffect, useState } from "react";
import { ls } from "./idb";

/**
 * "Hide amounts": one choice for this browser (not per account), kept on this device only. Every
 * open copy of the app (the side panel and the same extension in a tab, say) follows it at once.
 */
const KEY = "vs:mask";
const subs = new Set<(v: boolean) => void>();
let current: boolean | null = null;

const read = () => ls.get<boolean>(KEY, false) === true;

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY) return;
    current = read();
    subs.forEach((f) => f(current!));
  });
}

/** Whether amounts are hidden, and the switch. */
export function useMasked(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => (current ??= read()));
  useEffect(() => {
    subs.add(setV);
    setV((current ??= read()));
    return () => {
      subs.delete(setV);
    };
  }, []);
  return [
    v,
    (next: boolean) => {
      current = next;
      ls.set(KEY, next);
      subs.forEach((f) => f(next));
    },
  ];
}
