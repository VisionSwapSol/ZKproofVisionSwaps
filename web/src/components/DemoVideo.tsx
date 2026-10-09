import { useRef, useState } from "react";

/** The walkthrough's chapters, in seconds, so visitors can jump straight to the part they care about. */
const CHAPTERS: [string, number][] = [
  ["Connect", 7.3],
  ["Shield", 16],
  ["Privacy", 31.6],
  ["Buy", 54],
  ["Sell", 70],
  ["Send", 78.8],
  ["Extras", 87.6],
  ["Why us", 100.1],
];
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * One of the site's videos (the two-minute walkthrough unless told otherwise). Served from this site
 * (nothing loads from a third party), and only its first frames download until someone presses play.
 */
export function DemoVideo({
  src = "/media/tutorial-1.mp4",
  poster = "/media/tutorial-1.jpg",
  chapters = CHAPTERS,
  label = "Watch the walkthrough",
  length = "1:56",
  name = "VisionSwap walkthrough video, with on-screen captions",
  playName = "Play the VisionSwap walkthrough, 1 minute 56 seconds",
}: {
  src?: string;
  poster?: string;
  chapters?: [string, number][];
  label?: string;
  length?: string;
  name?: string;
  playName?: string;
} = {}) {
  const v = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  const play = (at?: number) => {
    const el = v.current;
    if (!el) return;
    setStarted(true);
    if (at != null) el.currentTime = at;
    void el.play().catch(() => {});
  };
  return (
    <div className="demo">
      <div className={`demo-frame ${started ? "on" : ""}`}>
        <video
          ref={v}
          src={src}
          poster={poster}
          preload="metadata"
          playsInline
          controls={started}
          onPlay={() => setStarted(true)}
          aria-label={name}
        />
        {!started && (
          <button type="button" className="demo-play" onClick={() => play()} aria-label={playName}>
            <span className="demo-play-row">
              <span className="demo-play-icon" aria-hidden="true" />
              <span className="demo-play-label">
                {label} <em>{length}</em>
              </span>
            </span>
          </button>
        )}
      </div>
      <nav className="demo-chapters" aria-label="Jump to a part of the video">
        {chapters.map(([part, at], i) => (
          <button key={part} type="button" onClick={() => play(at)}>
            <span className="mono">{String(i + 1).padStart(2, "0")}</span>
            {part}
            <em className="mono">{mmss(at)}</em>
          </button>
        ))}
      </nav>
    </div>
  );
}
