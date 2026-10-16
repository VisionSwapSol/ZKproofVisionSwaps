import { Fragment, useSyncExternalStore } from "react";
import { Icon } from "./Icon";
import { ANDROID_APP } from "../lib/androidApp";
import { androidAppLine, appEnv, inInstalledApp, isAndroidUA, isAppleMobileUA, type AppEnv } from "../lib/appinstall";
import {
  RELEASE_ATTR,
  androidReleaseBuiltSnapshot,
  androidReleaseSnapshot,
  availableLine,
  releaseAttr,
  subscribeAndroidRelease,
  type AndroidReleaseState,
} from "../lib/androidRelease";

/** What a prerendered page assumes (a desktop browser); the visitor's own browser takes over right after. */
const PAGE_ENV: AppEnv = { ua: "", standalone: false, referrer: "", launchedFromApp: false };
let seen: AppEnv | undefined;
const noChange = () => () => {};
/** This visitor's browser, read once per page and the same object every time (as useSyncExternalStore needs). */
function useAppEnv(): AppEnv {
  return useSyncExternalStore(noChange, () => (seen ??= appEnv()), () => PAGE_ENV);
}

const noSnapshot = () => androidReleaseSnapshot();

/**
 * Whether the Android app's download is open yet (see lib/androidRelease.ts): the page as built offers it,
 * the browser takes over from there and follows the moment (saying when it opens until then), so the
 * download appears at the moment without a reload. The server's own moment and clock arrive with /api/legal, which
 * the footer asks for on every page (legal/useLegal.ts hands them over).
 */
function useAndroidRelease(): AndroidReleaseState {
  return useSyncExternalStore(subscribeAndroidRelease, noSnapshot, androidReleaseBuiltSnapshot);
}

/** The direct download link to the Android app (the file keeps its name on every release). */
function AndroidDownload({ className = "btn violet" }: { className?: string }) {
  return (
    <a className={className} href={ANDROID_APP.href} download="VisionSwap.apk" type="application/vnd.android.package-archive">
      <Icon name="download" size={18} />
      Download for Android
    </a>
  );
}

/**
 * Android visitors get the download beside "Open app" in the hero (never inside the app itself); before
 * the release moment, when it opens instead.
 */
export function AndroidHeroButton() {
  const env = useAppEnv();
  const release = useAndroidRelease();
  if (!isAndroidUA(env.ua) || inInstalledApp(env)) return null;
  if (!release.released) {
    return (
      <span className="android-soon" {...{ [RELEASE_ATTR]: releaseAttr(release) }}>
        <Icon name="phone" size={16} />
        Android app · {availableLine(release.at)}
      </span>
    );
  }
  return <AndroidDownload />;
}

/** The footer's link to the download (not shown inside the app); before the release moment it says when it opens. */
export function AndroidAppLink() {
  const env = useAppEnv();
  const release = useAndroidRelease();
  if (inInstalledApp(env)) return null;
  return (
    <a href="/#get-app" {...{ [RELEASE_ATTR]: releaseAttr(release) }}>
      {release.released ? "Android app" : `Android app · ${availableLine(release.at)}`}
    </a>
  );
}

/** The homepage's "Get the app" section (#get-app): Android download and iPhone home-screen steps. */
export function GetAppSection() {
  const env = useAppEnv();
  const release = useAndroidRelease();
  if (inInstalledApp(env)) return null;
  const iphoneFirst = isAppleMobileUA(env.ua, typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints);
  return (
    <section className="get-app" id="get-app">
      <div className="wrap">
        <div className="watch-head">
          <div>
            <p className="eyebrow rise">Get the app</p>
            <h2 className="rise">VisionSwap on your phone.</h2>
          </div>
          <p className="body rise" style={{ ["--d" as string]: "100ms" }}>
            VisionSwap on your home screen. It opens full screen, straight into the app, with everything the website
            does.
          </p>
        </div>
        <div className={`get-app-grid${iphoneFirst ? " iphone-first" : ""}`}>
          <article className="get-app-card android rise">
            <span className="get-app-ico">
              <Icon name="phone" />
            </span>
            <h3>Android</h3>
            <p>The VisionSwap app for Android phones. It connects to the wallet apps on your phone.</p>
            <div className="get-app-go" {...{ [RELEASE_ATTR]: releaseAttr(release) }}>
              {release.released ? <AndroidDownload /> : <span className="get-app-meta">{availableLine(release.at)}</span>}
              <span className="get-app-meta mono">{androidAppLine()}</span>
            </div>
            <p className="tiny">
              Not offered in restricted places (<a href="/terms#eligibility">Terms of use, section 2</a>).
            </p>
            <ol className="get-app-steps">
              <li>
                <span>Tap Download for Android. When Chrome asks, tap Download anyway.</span>
              </li>
              <li>
                <span>Tap Open when the download finishes.</span>
              </li>
              <li>
                <span>The first time, tap Settings, turn on Allow from this source, go back and tap Install.</span>
              </li>
            </ol>
            <p className="get-app-sig">
              <span>App signature (SHA-256)</span>
              <code className="mono">
                {/* lines may break after a colon, never inside a pair (and a copy has no extra characters) */}
                {ANDROID_APP.certSha256.split(":").map((pair, i) => (
                  <Fragment key={i}>
                    {i > 0 && ":"}
                    {i > 0 && <wbr />}
                    {pair}
                  </Fragment>
                ))}
              </code>
            </p>
          </article>
          <article className="get-app-card iphone rise" style={{ ["--d" as string]: "90ms" }}>
            <span className="get-app-ico">
              <Icon name="phone" />
            </span>
            <h3>iPhone</h3>
            <p>Add VisionSwap to your Home Screen. It opens full screen, straight into the app.</p>
            <ol className="get-app-steps">
              <li>
                <span>
                  Open <span className="mono">visionswap.net/app</span> in Safari.
                </span>
              </li>
              <li>
                <span>Tap Share, then Add to Home Screen.</span>
              </li>
              <li>
                <span>Tap Add. VisionSwap is on your Home Screen.</span>
              </li>
            </ol>
          </article>
        </div>
      </div>
    </section>
  );
}
