/** The extension's own line icons (24 x 24, drawn with the current text colour). */
const PATHS = {
  home: "M4 11.5L12 4l8 7.5 M6 10v9.5a.5.5 0 0 0 .5.5H10v-5.5h4V20h3.5a.5.5 0 0 0 .5-.5V10",
  send: "M12 19V5 M6 11l6-6 6 6",
  receive: "M12 5v14 M6 13l6 6 6-6",
  swap: "M4 8h13l-3.5-3.5 M20 16H7l3.5 3.5",
  wallets: "M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3 M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5z M16 13.5h.01",
  activity: "M4 12h3.5l2.5-6 4 12 2.5-6H20",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 13.5l1.6 1.2-2 3.4-1.9-.7a7 7 0 0 1-2.1 1.2L14.7 21h-4l-.3-2.4a7 7 0 0 1-2.1-1.2l-1.9.7-2-3.4 1.6-1.2a7 7 0 0 1 0-2.4L4.4 9.9l2-3.4 1.9.7a7 7 0 0 1 2.1-1.2L10.7 3h4l.3 2.4a7 7 0 0 1 2.1 1.2l1.9-.7 2 3.4-1.6 1.2a7 7 0 0 1 0 2.4z",
  lock: "M6 10.5h12a1 1 0 0 1 1 1V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1z M8 10.5V8a4 4 0 0 1 8 0v2.5 M12 14.5v2",
  more: "M5.5 12h.01 M12 12h.01 M18.5 12h.01",
  back: "M15 5l-7 7 7 7",
  out: "M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  tab: "M3 6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6z M3 9h18",
  shield: "M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6L12 3z M8.5 12l2.4 2.4L15.8 9.6",
  key: "M14.5 9.5a4.5 4.5 0 1 1-1.3-3.2 M13.2 12.8L20 19.6V22h-3v-2h-2v-2h-2l-1.4-1.4 M7.5 9.5h.01",
  plus: "M12 5v14 M5 12h14",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2",
  chevron: "M9 6l6 6-6 6",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff:
    "M3 3l18 18 M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2 M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.4 M9.9 9.9a3 3 0 0 0 4.2 4.2",
  close: "M6 6l12 12 M18 6L6 18",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 3l9.5 17h-19L12 3z M12 10v4 M12 17h.01",
} as const;

export type GlyphName = keyof typeof PATHS;

export function Glyph({ name, size = 22, className = "" }: { name: GlyphName; size?: number; className?: string }) {
  return (
    <svg
      className={`glyph ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
