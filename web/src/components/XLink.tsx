import { SOCIAL } from "../lib/config";

/** The X logo, drawn here so nothing is fetched from X until someone clicks. */
export function XIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

/** A link to VisionSwap's official X account. */
export function XLink({ className, label = false, onClick }: { className?: string; label?: boolean; onClick?: () => void }) {
  return (
    <a
      href={SOCIAL.x}
      className={className}
      target="_blank"
      rel="noreferrer noopener"
      aria-label="VisionSwap on X"
      title="VisionSwap on X"
      onClick={onClick}
    >
      <XIcon />
      {label && <span>@VisionSwapSol</span>}
    </a>
  );
}
