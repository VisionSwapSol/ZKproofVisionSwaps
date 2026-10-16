import { test } from "node:test";
import assert from "node:assert/strict";
import { ANDROID_PACKAGE, androidAppLine, formatBytes, fromAndroidApp, inInstalledApp, isAndroidUA, isAppleMobileUA } from "../src/lib/appinstall.ts";
import { ANDROID_APP } from "../src/lib/androidApp.ts";

const PIXEL = "Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
const CHROME_REDUCED = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

test("Android visitors are told apart from everyone else", () => {
  assert.ok(isAndroidUA(PIXEL));
  assert.ok(isAndroidUA(CHROME_REDUCED), "Chrome's reduced user agent still says Android");
  assert.ok(!isAndroidUA(IPHONE));
  assert.ok(!isAndroidUA(DESKTOP));
  assert.ok(!isAndroidUA(""));
});

test("iPhone and iPad visitors (an iPad says it's a Mac with touch)", () => {
  assert.ok(isAppleMobileUA(IPHONE));
  assert.ok(isAppleMobileUA(IPAD, 5));
  assert.ok(!isAppleMobileUA(IPAD, 0), "a real Mac has no touch points");
  assert.ok(!isAppleMobileUA(PIXEL, 5));
});

test("inside the installed app the download prompts stay hidden", () => {
  const web = { standalone: false, referrer: "", launchedFromApp: false };
  assert.equal(inInstalledApp(web), false);
  assert.equal(inInstalledApp({ ...web, standalone: true }), true, "home-screen app or the Android app");
  assert.equal(inInstalledApp({ ...web, referrer: `android-app://${ANDROID_PACKAGE}/` }), true, "the Android app's first page");
  assert.equal(inInstalledApp({ ...web, launchedFromApp: true }), true, "a later page in the same visit");
  assert.equal(inInstalledApp({ ...web, referrer: "android-app://com.example.other/" }), false, "another app linking here");
  assert.equal(inInstalledApp({ ...web, referrer: "https://visionswap.net/" }), false);
  assert.ok(fromAndroidApp("android-app://net.visionswap.app"));
  assert.ok(!fromAndroidApp("https://android-app://net.visionswap.app"));
});

test("download size and version read the way phones show them", () => {
  assert.equal(formatBytes(1_857_525), "1.8 MB");
  assert.equal(formatBytes(2 * 1024 * 1024), "2.0 MB");
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(0), "");
  assert.equal(formatBytes(Number.NaN), "");
  assert.equal(androidAppLine({ version: "1.0.0", bytes: 1_857_525 }), "Version 1.0.0 · 1.8 MB");
  assert.equal(androidAppLine({ version: "1.0.0", bytes: 0 }), "Version 1.0.0");
});

test("the homepage's app facts are the Android build's (it writes them into lib/androidApp.ts)", () => {
  assert.equal(ANDROID_APP.href, "/download/VisionSwap.apk");
  assert.match(ANDROID_APP.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number.isInteger(ANDROID_APP.versionCode) && ANDROID_APP.versionCode >= 1);
  assert.ok(ANDROID_APP.bytes > 500_000 && ANDROID_APP.bytes < 20_000_000, "a Trusted Web Activity is a small download");
  assert.match(ANDROID_APP.certSha256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
});
