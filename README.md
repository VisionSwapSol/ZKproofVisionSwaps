<p align="center">
  <img src="brand/logo-original.webp" alt="VisionSwap" width="120" />
</p>

<h1 align="center">VisionSwap</h1>

<p align="center">
  <b>Private SOL payments and private trading of any Solana token, built on a zero-knowledge shielded pool.</b>
</p>

<p align="center">
  <a href="https://visionswap.net">visionswap.net</a> ·
  <a href="https://visionswap.net/docs">Docs</a> ·
  <a href="https://x.com/VisionSwapSol">@VisionSwapSol</a> ·
  <a href="docs/RELEASE-NOTES.md">Release notes</a>
</p>

<p align="center">Release 1.10.1 · Program <code>VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6</code> on Solana mainnet</p>

---

## What VisionSwap is

VisionSwap is a non-custodial shielded pool on Solana. You deposit SOL into the pool, and from then on you can:

- **Send SOL privately** to any wallet or exchange. The recipient receives a standard SOL transfer.
- **Trade any Solana token privately** through Vision wallets funded from the pool, with price protection on every quote and transaction.
- **Run private orders:** limit buys, DCA, take-profits in up to four steps, stop-losses and trailing stops.
- **Schedule and split payments**, or share a payment link.

VisionSwap runs on [visionswap.net](https://visionswap.net), in VisionSwap for Chrome (a side panel beside any page) and in VisionSwap for Android.

## How it works

- **Notes and commitments.** A balance in the pool is a set of notes. Each note is a Poseidon commitment to its amount, its owner's public key and a random blinding value.
- **Merkle tree.** The program appends every commitment to an on-chain Merkle tree of depth 26. A deposit is screened in an on-chain waiting room first, and the program then computes its leaf itself (`settle`).
- **Groth16 proofs.** A spend is a Groth16 proof over BN254, generated in the user's browser, for a circuit with two input notes and two output notes. The proof shows that the input notes are in the tree and that amounts balance. Its public inputs are the tree root, the amount leaving the pool, the external data hash, two nullifiers and two new commitments, and the program verifies it on-chain.
- **Nullifiers.** Each spent note reveals a nullifier, and the program records it, so a note can be spent only once.
- **Encrypted notes, found on the user's device.** Each new note is published with a short record, a recognition tag and its amount, encrypted with its owner's viewing key. The app downloads the pool's notes and recognises its own on the user's device.
- **Relayed spends.** A relayer submits the proof and pays the network fee. The proof commits to the amount leaving the pool, and its external data hash commits to the recipient, the relayer and its fee, the highest pool fee the spender accepts and the new notes' encrypted records, so the relayer submits the spend exactly as it was proved.
- **Keys.** Spending and viewing keys are derived from a signature by the user's own wallet, so there is no new seed phrase. Accounts can also be opened with a private key or a passkey.

The full protocol, fees and screening rules are in [the docs](https://visionswap.net/docs).

## In this repository

| Folder | Contents | License |
| --- | --- | --- |
| [`program/`](program/) | The Anchor program deployed on mainnet: vault, waiting room, Merkle tree, on-chain Groth16 verifier and fees, with its pinned toolchain, lockfile and release record | [BUSL-1.1](program/LICENSE) |
| [`circuits/`](circuits/) | The Circom transaction circuit (2 inputs, 2 outputs, depth 26), its proving files and setup transcript, and the trusted-setup and ceremony tooling | [GPL-3.0-or-later](LICENSE-GPL) |
| [`sdk/`](sdk/) | TypeScript SDK: keys, notes, tree, proofs, transaction builders, events and trade price checks | [GPL-3.0-or-later](LICENSE-GPL) |
| [`web/`](web/) | The web app served at visionswap.net (React, Vite, three.js) | [GPL-3.0-or-later](LICENSE-GPL) |
| [`extension/`](extension/) | VisionSwap for Chrome, running the web app's own code and proofs in Chrome's side panel | [GPL-3.0-or-later](LICENSE-GPL) |
| [`release/`](release/), [`scripts/check-release.mjs`](scripts/check-release.mjs) | The 1.10.1 build manifest and the tool that compares a build with it | [GPL-3.0-or-later](LICENSE-GPL) |

The VisionSwap service (relayer, indexer, screening and order services) and its operations tooling are operated by VisionSwap and are not published in this repository; [`server/`](server/) holds only data files used by the tests.

## Verify it yourself

### The deployed program

The program `VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6` has executable hash `7edb58080a4d73584cb70d0a46e041765a0052ce81fed3885fd7935006fd177d`, and the source in this repository rebuilds it byte for byte.

1. Install the toolchain pinned in [`program/toolchain.env`](program/toolchain.env) (Agave CLI 3.1.13 with platform-tools v1.52) on Linux.
2. Run `bash program/scripts/verify-build.sh`. It builds the program in a fresh folder and prints the matching entry of [`program/RELEASES.json`](program/RELEASES.json):

   ```
   MATCH: version 1.0.0 (deployed, mainnet-beta), source commit 3c2a7d977b59
   ```

3. Compare with the chain: `node program/scripts/check-deployed.mjs`, or `solana-verify get-program-hash -u https://api.mainnet-beta.solana.com VSwJY1r9S7nNUyvBzWYr1rBkEMyTAjDFGtixxLGpmt6`. Both print `7edb5808...177d`.

[`program/BUILD.md`](program/BUILD.md) explains every step, including the container route with `solana-verify`.

### The circuit, its verification key and proving files

- [`circuits/artifacts/`](circuits/artifacts/) holds the proving files (`transaction.wasm`, `transaction.zkey`), the verification key and [`TRANSCRIPT.json`](circuits/artifacts/TRANSCRIPT.json), the record of the trusted setup: phase 1 is the Perpetual Powers of Tau (`ppot_0080_15.ptau`), and phase 2 was sealed with a beacon from Bitcoin block 969,748.
- Compile the circuit with circom 2.2 (`cd circuits && npm ci && npm run build`), place `ppot_0080_15.ptau` in `circuits/ptau/`, and run `npm test` there: it verifies the final proving key against the circuit, the phase-1 file and the transcript.
- `node --import tsx sdk/scripts/gen-rust.ts` regenerates the program's verifying-key constants from `circuits/artifacts/verification_key.json`; the result is identical to [`program/programs/vision_pool/src/constants.rs`](program/programs/vision_pool/src/constants.rs).
- The apps pin the proving files by SHA-256 ([`sdk/src/provingfiles.ts`](sdk/src/provingfiles.ts)) and check them before every proof; `npm test -w sdk` confirms the files in this repository are the pinned ones and the ones the transcript names.

### T### The website and extension builds

Each release ships a build manifest, [`release/visionswap-release.json`](release/visionswap-release.json), with the SHA-256 of every file in the release: the website's code and pages, the Chrome extension, the Android app and the deployed program. The manifest for 1.10.1 has SHA-256 `adff877c5424256481649e2345c1bc36fb9476e0fe739d124fd5008af0742c0b`.

`npm run build` produces the website's code and pages, and `npm run build:extension` produces the Chrome extension, with the SHA-256 values the manifest lists. [`scripts/check-release.mjs`](scripts/check-release.mjs) compares a deployment with a manifest file by file.

velopment

Requires Node.js 22.13 or later.

```bash
npm ci
npm test                  # SDK, web app and extension tests, including a real Groth16 proof
npm run typecheck
npm run build             # the web app, into web/dist
npm run build:extension   # VisionSwap for Chrome, into extension/dist
npm run dev:web           # the web app's development server
```

The circuit tooling has its own dependencies (`cd circuits && npm ci`). The program builds with the toolchain in [`program/toolchain.env`](program/toolchain.env): `bash program/scripts/build.sh` builds it, `(cd program && cargo test --locked --lib)` runs its unit tests, and `bash program/scripts/localnet.sh` starts a local validator with it. [`program/BUILD.md`](program/BUILD.md) covers the details.

## Security

Please report vulnerabilities privately to **support@visionswap.net**; see [`SECURITY.md`](SECURITY.md). An independent security review is underway.

## License

The program in `program/` is licensed under the Business Source License 1.1 ([`program/LICENSE`](program/LICENSE)), which converts to GPL-3.0-or-later on 2030-10-16. The circuit, SDK, web app and Chrome extension are licensed under GPL-3.0-or-later ([`LICENSE-GPL`](LICENSE-GPL)). The VisionSwap name, logo and brand assets are not licensed for use. See [`LICENSE`](LICENSE) for the full breakdown.

---

[visionswap.net](https://visionswap.net) · [@VisionSwapSol](https://x.com/VisionSwapSol) · support@visionswap.net · business@visionswap.net (business only)
