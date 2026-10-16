import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { SolanaMobileWalletAdapter } from "@solana-mobile/wallet-adapter-mobile";
import {
  APP_ICON,
  APP_NAME,
  appIdentity,
  createMobileWalletAdapter,
  inferredCluster,
  isMobileWeb,
  mobileAdapterConfig,
  SolanaMobileWalletAdapterWalletName as MWA_NAME,
} from "../src/lib/mwa.ts";

const here = dirname(fileURLToPath(import.meta.url));

// the provider's own helpers (not exported by the package), to check ours answer the same
const providerDir = join(dirname(createRequire(import.meta.url).resolve("@solana/wallet-adapter-react")), "..", "esm");
const upstream = async (file: string) => (await import(pathToFileURL(join(providerDir, file)).href)).default;

test("wallet apps are told the app's name, its address and an icon path relative to it", () => {
  const id = appIdentity("https://visionswap.net");
  assert.deepEqual(id, { name: "VisionSwap", uri: "https://visionswap.net", icon: "icon-192.png" });
  assert.equal(APP_NAME, "VisionSwap");
  // the protocol wants the icon as a path relative to uri, never an absolute address
  assert.ok(!/^[a-z]+:|^\/\//i.test(APP_ICON));
  // and the file is there, square
  const png = readFileSync(join(here, "..", "public", APP_ICON));
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
  assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
});

test("the cluster is the one the provider would have inferred from the same endpoint", async () => {
  const theirs = await upstream("getInferredClusterFromEndpoint.js");
  for (const e of [
    undefined,
    "",
    "https://visionswap.net/api/rpc",
    "http://127.0.0.1:5196/api/rpc",
    "http://127.0.0.1:8899",
    "https://api.devnet.solana.com",
    "https://API.TESTNET.solana.com",
    "https://mainnet.helius-rpc.com/?api-key=x",
  ]) {
    assert.equal(inferredCluster(e), theirs(e), String(e));
  }
  // with no ConnectionProvider (this app) the provider sees no endpoint: mainnet, as before
  assert.equal(inferredCluster(undefined), "mainnet-beta");
});

test("the adapter appears exactly where the provider would add its own", async () => {
  const getEnvironment = await upstream("getEnvironment.js");
  const MOBILE_WEB = 1;
  const agents = [
    null,
    "Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.60 Mobile Safari/537.36",
    // an app's WebView, both spellings
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.7444.60 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  ];
  const lists = [
    [],
    [{ name: "Phantom", readyState: WalletReadyState.Installed }],
    [{ name: "Solflare", readyState: WalletReadyState.Loadable }],
    [{ name: "Test wallet (local only)", readyState: WalletReadyState.Installed }],
    [{ name: MWA_NAME, readyState: WalletReadyState.Installed }],
    [{ name: "Backpack", readyState: WalletReadyState.NotDetected }],
  ];
  let mobileCases = 0;
  for (const ua of agents) {
    for (const adapters of lists) {
      const want = getEnvironment({ adapters, userAgentString: ua }) === MOBILE_WEB;
      assert.equal(isMobileWeb(adapters, ua), want, `${ua} / ${adapters.map((a) => a.name).join(",")}`);
      if (want) mobileCases++;
    }
  }
  assert.ok(mobileCases > 0);
  // an Android phone browser with nothing installed gets it; a desktop or an installed wallet doesn't
  assert.equal(isMobileWeb([], agents[2]), true);
  assert.equal(isMobileWeb([{ name: "Phantom", readyState: WalletReadyState.Installed }], agents[2]), false);
  assert.equal(isMobileWeb([], agents[6]), false);
});

test("it is the provider's own adapter type, under the name the provider looks for, with the provider's defaults", () => {
  const cfg = mobileAdapterConfig("https://visionswap.net", "mainnet-beta");
  assert.equal(cfg.cluster, "mainnet-beta");
  assert.deepEqual(cfg.appIdentity, appIdentity("https://visionswap.net"));
  assert.equal(typeof cfg.addressSelector.select, "function");
  assert.equal(typeof cfg.authorizationResultCache.get, "function");
  assert.equal(typeof cfg.onWalletNotFound, "function");
  const a = createMobileWalletAdapter("https://visionswap.net", "mainnet-beta");
  assert.ok(a instanceof SolanaMobileWalletAdapter);
  assert.equal(a.name, MWA_NAME);
  assert.equal(a.name, "Mobile Wallet Adapter");
  // the first address a wallet offers is the one used, as before
  return cfg.addressSelector.select(["b", "a"]).then((x) => assert.equal(x, "b"));
});
