import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain .mjs build helper, checked here by what it returns
import { manifest, csp, DESCRIPTION } from "../scripts/manifest.mjs";

const KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA";

test("the published manifest: narrow permissions, visionswap.net only, no key, no local addresses", () => {
  const m = manifest({ version: "1.0.0", key: KEY });
  assert.equal(m.manifest_version, 3);
  assert.equal(m.name, "VisionSwap");
  assert.deepEqual(m.permissions, ["sidePanel", "storage"]);
  assert.deepEqual(m.host_permissions, ["https://visionswap.net/*"]);
  assert.deepEqual(m.externally_connectable, { matches: ["https://visionswap.net/*"] });
  assert.equal(m.side_panel.default_path, "sidepanel.html");
  assert.deepEqual(m.background, { service_worker: "background.js", type: "module" });
  assert.equal(m.minimum_chrome_version, "116");
  assert.equal("key" in m, false, "the store assigns the ID");
  assert.doesNotMatch(JSON.stringify(m), /localhost|127\.0\.0\.1|http:\/\//);
  const policy = m.content_security_policy.extension_pages;
  assert.match(policy, /^script-src 'self' 'wasm-unsafe-eval'; object-src 'self';/);
  assert.match(policy, /connect-src 'self' https:\/\/visionswap\.net(;|$)/);
  assert.match(policy, /default-src 'self'(;|$)/, "nothing else loads from anywhere but the package");
  assert.ok(DESCRIPTION.length <= 132, "the store's limit for the summary");
});

test("the development manifest adds the local server and site, and may pin a test ID", () => {
  const m = manifest({ dev: true, version: "1.0.0", key: KEY });
  assert.equal(m.key, KEY);
  assert.ok(m.host_permissions.includes("http://127.0.0.1:8787/*"));
  assert.ok(m.host_permissions.includes("http://localhost:5196/*"));
  assert.ok(m.externally_connectable.matches.includes("http://localhost:5196/*"));
  assert.match(m.content_security_policy.extension_pages, /connect-src 'self' http:\/\/127\.0\.0\.1:8787/);
  for (const api of ["https://visionswap.net", "http://127.0.0.1:8787"]) assert.doesNotMatch(csp(api), /'unsafe-eval'|'unsafe-inline'|https?:\/\/\*/, "nothing looser than the proof's WebAssembly");
});
