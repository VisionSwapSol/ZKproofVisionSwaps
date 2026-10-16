import { useEffect, useState } from "react";
import { getReleaseCountdown, RELEASE_DATE } from "../lib/release-countdown";
import "../styles/release-countdown.css";

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function ReleaseCountdown() {
  // null until the page is up: the prerendered page can't know the visitor's time, so both start the same
  const [now, setCountdown] = useState<ReturnType<typeof getReleaseCountdown> | null>(null);
  const countdown = now ?? { hours: 0, minutes: 0, seconds: 0, complete: false };
  const shown = (v: number, padded: boolean) => (now ? (padded ? pad(v) : String(v)) : "--");

  useEffect(() => {
    let intervalId: number | undefined;

    const syncCountdown = () => {
      const next = getReleaseCountdown(Date.now());
      setCountdown(next);
      if (next.complete && intervalId !== undefined) {
        window.clearInterval(intervalId);
        intervalId = undefined;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") syncCountdown();
    };

    intervalId = window.setInterval(syncCountdown, 1000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", syncCountdown);
    syncCountdown();

    return () => {
      if (intervalId !== undefined) window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", syncCountdown);
    };
  }, []);

  return (
    <aside className={`release-countdown${countdown.complete ? " is-complete" : ""}`} aria-labelledby="release-countdown-title">
      <div className="release-countdown-copy">
        <span className="release-countdown-mark" aria-hidden="true" />
        <div>
          <p className="release-countdown-kicker">On the horizon</p>
          <h2 id="release-countdown-title">VisionSwap Chrome extension release</h2>
          <p className="release-countdown-deadline">
            <time dateTime={RELEASE_DATE}>October 15, 2026 <span>at 12:00 PM PST</span></time>
          </p>
        </div>
      </div>

      {countdown.complete ? (
        <p className="release-countdown-complete" role="status" aria-live="polite">
          Scheduled release time reached
        </p>
      ) : (
        <div className="release-countdown-clock" role="timer" aria-live="off" aria-label="Time remaining until the scheduled release">
          <div className="release-countdown-unit">
            <span className="release-countdown-value">{shown(countdown.hours, false)}</span>
            <span className="release-countdown-label">Hours</span>
          </div>
          <span className="release-countdown-separator" aria-hidden="true">:</span>
          <div className="release-countdown-unit">
            <span className="release-countdown-value">{shown(countdown.minutes, true)}</span>
            <span className="release-countdown-label">Minutes</span>
          </div>
          <span className="release-countdown-separator" aria-hidden="true">:</span>
          <div className="release-countdown-unit">
            <span className="release-countdown-value">{shown(countdown.seconds, true)}</span>
            <span className="release-countdown-label">Seconds</span>
          </div>
        </div>
      )}
    </aside>
  );
}
