/**
 * The Android app's release moment on the website (lib/androidRelease.ts, components/GetApp.tsx): before
 * it, the "Get the app" section, the hero's Android button and the footer's link say when the download
 * opens, with no link to the APK; from it on, everything is as before. Every test runs on a clock of its
 * own (node's mock timers), never the real one.
 */
import { afterEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ANDROID_RELEASE_DEFAULT,
  ANDROID_RELEASE_DEFAULT_AT,
  androidReleaseBuiltSnapshot,
  androidReleaseSnapshot,
  androidWhen,
  availableLine,
  parseAndroidRelease,
  releaseState,
  resetAndroidReleaseForTests,
  setAndroidRelease,
  subscribeAndroidRelease,
} from "../src/lib/androidRelease.ts";
import { DEFAULT_LEGAL_INFO, parseLegalInfo } from "../src/legal/info.ts";
import { AndroidAppLink, GetAppSection } from "../src/components/GetApp.tsx";

const AT = Date.parse("2026-10-15T20:00:00Z");
const LINE = "Available October 15 at 12:00 PM PST";
const APK_LINK = 'href="/download/VisionSwap.apk"';

afterEach(() => {
  mock.timers.reset();
  resetAndroidReleaseForTests();
});

/** The clock (Date and timers) at `now`. */
function clockAt(now: number) {
  mock.timers.reset();
  mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  resetAndroidReleaseForTests();
}

test("the default moment is the owner's: October 15, 2026 at 12:00 PM PST (20:00 UTC), and it reads that way", () => {
  assert.equal(ANDROID_RELEASE_DEFAULT, "2026-10-15T12:00:00-08:00");
  assert.equal(ANDROID_RELEASE_DEFAULT_AT, AT);
  assert.equal(availableLine(AT), LINE);
  assert.equal(androidWhen(Date.parse("2026-11-01T00:30:00Z")), "October 31 at 4:30 PM PST", "the same words as the server's 404");
});

test("/api/legal's android is checked; a server that doesn't say leaves the default", () => {
  assert.deepEqual(parseAndroidRelease({ releaseAt: "2026-10-15T20:00:00.000Z", startsIn: 90 }), { releaseAt: AT, startsIn: 90 });
  assert.deepEqual(parseAndroidRelease({ releaseAt: null, startsIn: 0 }), { releaseAt: null, startsIn: 0 });
  for (const bad of [undefined, null, [], {}, { releaseAt: "soon", startsIn: 1 }, { releaseAt: "2026-10-15T20:00:00Z", startsIn: -1 }, { releaseAt: "2026-10-15T20:00:00Z" }]) {
    assert.equal(parseAndroidRelease(bad), null, JSON.stringify(bad));
  }
  assert.equal(DEFAULT_LEGAL_INFO.android, null);
  assert.deepEqual(parseLegalInfo({ android: { releaseAt: "2026-10-15T20:00:00.000Z", startsIn: 5 } }).android, { releaseAt: AT, startsIn: 5 });
  assert.equal(parseLegalInfo({}).android, null);
});

test("released from the moment on (and with no moment at all)", () => {
  assert.deepEqual(releaseState(AT, AT, AT - 1), { released: false, at: AT });
  assert.deepEqual(releaseState(AT, AT, AT), { released: true, at: AT });
  assert.deepEqual(releaseState(null, null, AT - 1), { released: true, at: AT });
});

test("the page follows the moment on its own: listeners hear the download open, with no reload", () => {
  clockAt(AT - 5_000);
  const heard: boolean[] = [];
  const stop = subscribeAndroidRelease(() => heard.push(androidReleaseSnapshot().released));
  assert.equal(androidReleaseSnapshot().released, false);
  const same = androidReleaseSnapshot();
  assert.equal(androidReleaseSnapshot(), same, "the same object while nothing changes");
  mock.timers.tick(4_000);
  assert.deepEqual(heard, []);
  mock.timers.tick(1_100);
  assert.deepEqual(heard, [true]);
  assert.equal(androidReleaseSnapshot().released, true);
  stop();
});

test("once the server answers, its clock decides: a visitor's clock running ahead or behind doesn't move the moment", () => {
  // this browser's clock is an hour ahead: by its own clock the moment has passed, but the server says 30 s are left
  clockAt(AT + 3_600_000);
  assert.equal(androidReleaseSnapshot().released, true, "before the server answers, the visitor's clock");
  setAndroidRelease({ releaseAt: AT, startsIn: 30 });
  assert.equal(androidReleaseSnapshot().released, false);
  mock.timers.tick(30_000);
  assert.equal(androidReleaseSnapshot().released, true);

  // behind: the server says it is open
  clockAt(AT - 3_600_000);
  setAndroidRelease({ releaseAt: AT, startsIn: 0 });
  assert.equal(androidReleaseSnapshot().released, true);

  // the owner moved the moment (ANDROID_RELEASE_AT): the line says the new one
  clockAt(AT - 1000);
  const later = Date.parse("2026-10-16T18:00:00Z");
  setAndroidRelease({ releaseAt: later, startsIn: Math.round((later - (AT - 1000)) / 1000) });
  assert.deepEqual(androidReleaseSnapshot(), { released: false, at: later });
  assert.equal(availableLine(later), "Available October 16 at 10:00 AM PST");

  // off: open now
  setAndroidRelease({ releaseAt: null, startsIn: 0 });
  assert.equal(androidReleaseSnapshot().released, true);
});

/** What the browser shows at the clock's moment, rendered (the components read the page's state as a page being taken over does). */
function renderNow(el: Parameters<typeof createElement>[0]) {
  resetAndroidReleaseForTests(androidReleaseSnapshot());
  return renderToStaticMarkup(createElement(el as never));
}

test("before the moment: the section and the footer say when it opens, and nothing links to the APK", () => {
  clockAt(AT - 60_000);
  const section = renderNow(GetAppSection);
  assert.ok(section.includes(`<span class="get-app-meta">${LINE}</span>`), section);
  assert.ok(!section.includes(APK_LINK));
  assert.match(section, /data-android-release="soon"/);
  assert.match(section, /Version 1\.0\.0/, "the version line stays");
  const footer = renderNow(AndroidAppLink);
  assert.equal(footer, `<a href="/#get-app" data-android-release="soon">Android app · ${LINE}</a>`);
});

test("from the moment on: the download, as before", () => {
  clockAt(AT);
  const section = renderNow(GetAppSection);
  assert.ok(section.includes(APK_LINK));
  assert.ok(section.includes("Download for Android"));
  assert.ok(!section.includes(LINE));
  assert.match(section, /data-android-release="open"/);
  assert.equal(renderNow(AndroidAppLink), '<a href="/#get-app" data-android-release="open">Android app</a>');
});

test("the pages as built offer the download whenever they are built (the same bytes for the release manifest, never stale after the moment)", () => {
  for (const now of [AT - 86_400_000, AT - 1, AT, AT + 86_400_000]) {
    clockAt(now);
    assert.deepEqual(androidReleaseBuiltSnapshot(), { released: true, at: AT });
    const section = renderToStaticMarkup(createElement(GetAppSection));
    assert.ok(section.includes(APK_LINK) && section.includes('data-android-release="open"') && !section.includes(LINE), String(now));
  }
});

test("taking over a page as built: the first render is what the page says (no hydration mismatch), the moment's state right after", () => {
  const realDocument = (globalThis as { document?: unknown }).document;
  const page = (shown: string) =>
    ((globalThis as { document?: unknown }).document = {
      querySelector: (sel: string) => (sel === "[data-android-release]" ? { getAttribute: () => shown } : null),
    });
  try {
    // a page as built (the download) opened before the moment
    clockAt(AT - 60_000);
    page("open");
    assert.deepEqual(androidReleaseBuiltSnapshot(), { released: true, at: AT }, "the first render matches the HTML");
    assert.equal(androidReleaseSnapshot().released, false, "then the browser says when it opens");
    // and a page that said "soon" (built by an earlier version) opened after it
    clockAt(AT + 60_000);
    page("soon");
    assert.deepEqual(androidReleaseBuiltSnapshot(), { released: false, at: AT });
    assert.equal(androidReleaseSnapshot().released, true);
  } finally {
    (globalThis as { document?: unknown }).document = realDocument;
  }
});
