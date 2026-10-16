import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Icon } from "../components/Icon";
import { SOCIAL } from "../lib/config";
import { api, explorerAccount } from "../lib/net";
import { POOL_PROGRAM_ID } from "../lib/faq";
import { ANDROID_APP } from "../lib/androidApp";
import { BUSINESS_EMAIL, SUPPORT_EMAIL, mailto } from "../lib/contacts";
import { shownLegal, useLegal } from "../legal/useLegal";
import { PAGES, longDate } from "../seo/pages";
import "../styles/legal.css";

/**
 * Security: how VisionSwap is built, what you trust when you use it, the VisionSwap team's control
 * over the program, the audit status and how to report a problem. Every sentence has to stay true to
 * the code and to how VisionSwap runs today (web/test/claims.test.ts scans it).
 */

type Info = {
  network: string;
  programId: string;
  program?: { upgradeAuthority: string | null; deployedSlot: number; sha256: string } | null;
};

const SECTIONS: [string, string][] = [
  ["built", "How VisionSwap is built"],
  ["keys", "Your keys"],
  ["code", "The code you run"],
  ["control", "Upgrades and settings"],
  ["setup", "The trusted setup"],
  ["audits", "Audits and testing"],
  ["report", "Reporting a security problem"],
  ["incidents", "If something goes wrong"],
  ["safe", "Staying safe"],
];

export default function SecurityPage() {
  const legal = useLegal();
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    api<Info>("/api/pool/info").then(setInfo).catch(() => {});
  }, []);
  const network = info?.network ?? "mainnet";
  const programId = info?.programId ?? POOL_PROGRAM_ID;
  // SECURITY_CONTACT: support@visionswap.net unless the owner names another (the default until /api/legal answers)
  const security = shownLegal(legal).security;
  const x = (
    <a href={SOCIAL.x} target="_blank" rel="noreferrer noopener">
      @VisionSwapSol on X
    </a>
  );
  return (
    <div className="page prose-page">
      <Header />
      <main className="wrap prose terms">
        <h1>Security</h1>
        <p className="lede">
          How VisionSwap is designed to keep your funds under your control, what you rely on when you use it, and how to tell us about a
          problem. Each point describes VisionSwap as it runs today, and the <a href="/terms#risks">Terms of use</a> set out the risks.
        </p>
        <p className="muted">Last updated {longDate(PAGES.security.updated)}.</p>

        <div className="legal-cards">
          <div className="legal-card">
            <Icon name="key" size={22} />
            <strong>Self-custody</strong>
            <p>Your spending and viewing keys are made on your device and never reach our servers.</p>
          </div>
          <div className="legal-card">
            <Icon name="proof" size={22} />
            <strong>Checked on-chain</strong>
            <p>Every spend from the pool needs a valid zero-knowledge proof, which the program checks itself.</p>
          </div>
          <div className="legal-card">
            <Icon name="radar" size={22} />
            <strong>Open about control</strong>
            <p>The VisionSwap team can upgrade the program and change its settings today. Both show on-chain.</p>
          </div>
          <div className="legal-card">
            <Icon name="flag" size={22} />
            <strong>Report a problem</strong>
            <p>Found a vulnerability? Tell us privately, as the reporting section below explains.</p>
          </div>
        </div>

        <ul className="legal-toc" aria-label="On this page">
          {SECTIONS.map(([id, t]) => (
            <li key={id}>
              <a href={`#${id}`}>{t}</a>
            </li>
          ))}
        </ul>

        <h2 id="built">How VisionSwap is built</h2>
        <ul>
          <li>
            <strong>The pool.</strong> Shielded SOL sits in a vault owned by the VisionSwap program on Solana. It can leave only against a
            valid zero-knowledge proof (Groth16, verified by the program itself), or, while a deposit is still in the waiting room, back to
            the address that deposited it. No admin setting can move or redirect it, though an upgrade could change these rules (see{" "}
            <a href="#control">Upgrades and settings</a>).
          </li>
          <li>
            <strong>Notes and proofs.</strong> Your private balance is a set of notes in the pool's public note tree. Your browser downloads
            every note, finds your own with your viewing key, and builds each proof on your device. A proof shows that a payment is yours to
            make without saying which deposit paid for it.
          </li>
          <li>
            <strong>The relayer.</strong> A relayer submits each private payment to Solana and pays its network fee, which the payment repays.
            The recipient, the amount, the relayer fee and the highest pool fee you accept are bound into the proof, so the relayer can't
            change them. The program accepts any fee payer, so anyone can run a relayer; ours is the default, and you can also send a payment
            yourself with a fee payer of your own.
          </li>
          <li>
            <strong>One-time sending addresses.</strong> A private send to an address outside your own VisionSwap wallets goes through a
            one-time sending address made for that payment, which only your app holds the key to, and arrives as a standard SOL transfer.
          </li>
          <li>
            <strong>Screening.</strong> Deposits are screened and wait in a public waiting room before they join the pool, and flagged ones can
            only go back to the address they came from. The <a href="/compliance">Compliance</a> page explains how, and publishes our{" "}
            <a href="/compliance#policy">screening policy</a>.
          </li>
        </ul>

        <h2 id="keys">Your keys</h2>
        <ul>
          <li>
            Your account's keys are made on your device: from your wallet's signature of one fixed message, from a passkey, or from a
            VisionSwap private key. Your spending and viewing keys never reach our servers, and our servers cannot spend your private balance.
          </li>
          <li>
            Vision wallets, deposit addresses, fee wallets and order keys each come from your account through their own one-way derivation, so
            none of them reveals your spending or viewing key.
          </li>
          <li>
            "Keep me signed in" seals your private key with a key that your browser made and can't export, so the saved copy opens only in
            that browser. It's off unless you turn it on.
          </li>
          <li>
            Orders are the one place our service holds a key over your funds, and only as far as you choose: an order's key can move only
            the amount you set aside for it (for a DCA, its whole budget), only from its own Vision wallet, and only until the order ends or
            you cancel it. The token program enforces that amount. Order details are stored encrypted, and an order's key is deleted from our
            records when the order ends.
          </li>
          <li>
            Nobody, including us, can recover a lost key. Keep your private key or a passkey account's backup key somewhere safe and offline.
          </li>
        </ul>

        <h2 id="code">The code you run</h2>
        <ul>
          <li>
            The web app is loaded from visionswap.net each time you open it, so that code is part of what you trust. The site loads no
            third-party scripts, fonts or trackers, and a strict content security policy lets each page run only its own code.
          </li>
          <li>
            The Chrome extension carries its own copy of the app, published through the Chrome Web Store
            {legal?.extensionId ? (
              <>
                {" "}
                with the ID <code>{legal.extensionId}</code>
              </>
            ) : null}
            . It talks only to visionswap.net.
          </li>
          <li>
            The Android app opens visionswap.net full screen. Its signing certificate's SHA-256 fingerprint is{" "}
            <code>{ANDROID_APP.certSha256}</code>, also listed in{" "}
            <a href="/.well-known/assetlinks.json" target="_blank" rel="noreferrer noopener">
              /.well-known/assetlinks.json
            </a>
            ; Android installs an update only if it is signed with the same key.
          </li>
          <li>
            Our server writes no IP addresses or wallet addresses to its logs, keeps scheduled payments and orders encrypted, and limits how
            often each connection can call its API. Our hosting provider keeps its own connection records; the <a href="/privacy">Privacy policy</a>{" "}
            lists what each service sees and for how long.
          </li>
          {legal?.repo && (
            <li>
              VisionSwap's source code is published at{" "}
              <a href={legal.repo} target="_blank" rel="noreferrer noopener">
                {legal.repo.replace(/^https:\/\//, "")}
              </a>
              , under open-source licences.
            </li>
          )}
        </ul>

        <h2 id="control">Upgrades and settings</h2>
        <p>
          The program is upgradeable today, and the VisionSwap team holds the key that upgrades it. An upgrade can change the program's rules,
          and it takes effect when it is deployed. The team also manages the pool's settings: the pool fee (never above 1%), the deposit limits
          and pool cap, the waiting room (up to the program's cap), whether a deposit needs a screening pass and the key that signs those
          passes, the fee wallet, and a pause for new deposits. Setting changes take effect when they are made. The <a href="/terms#control">Terms of use, section 8</a>, set out exactly
          what the team can and can't do.
        </p>
        <p>
          Our plan is to move the upgrade key to a multisig and, once the code has been audited, to make the program permanent. That is a
          plan, not a promise, and a permanent program would still have the settings above.
        </p>
        <dl className="proof">
          <div>
            <dt>Program</dt>
            <dd>
              <a className="mono proof-addr" href={explorerAccount(programId, network)} target="_blank" rel="noreferrer noopener">
                {programId}
              </a>
              <span>The VisionSwap pool program on Solana {network}.</span>
            </dd>
          </div>
          {info?.program && (
            <>
              <div>
                <dt>Upgrade key</dt>
                <dd>
                  {info.program.upgradeAuthority ? (
                    <a className="mono proof-addr" href={explorerAccount(info.program.upgradeAuthority, network)} target="_blank" rel="noreferrer noopener">
                      {info.program.upgradeAuthority}
                    </a>
                  ) : (
                    <span>None: the program's code is permanent (its settings remain).</span>
                  )}
                  {info.program.upgradeAuthority && <span>Held by the VisionSwap team. Watch it to see any upgrade.</span>}
                </dd>
              </div>
              <div>
                <dt>Deployed code</dt>
                <dd>
                  <code className="proof-hash">sha256 {info.program.sha256}</code>
                  <span>
                    Last deployed at slot {info.program.deployedSlot.toLocaleString("en-US")}. Run{" "}
                    <code>solana-verify get-program-hash {programId}</code> to see the same fingerprint for yourself.
                  </span>
                </dd>
              </div>
            </>
          )}
        </dl>
        <p className="small muted">
          More on-chain details, including the vault, the note tree and the settings account, are in the{" "}
          <a href="/docs#onchain">Docs</a>.
        </p>

        <h2 id="setup">The trusted setup</h2>
        <p>
          The proving keys come from a two-phase trusted setup that builds on the public "perpetual powers of tau" (61 public contributions
          and a random beacon). Phase two was completed by the VisionSwap team and sealed with a final random beacon from a Bitcoin block, and
          its record is part of the public proving key the app downloads. As with any trusted setup, the proofs are sound as long as the
          randomness used in phase two was discarded; your payments' privacy doesn't depend on it.
        </p>

        <h2 id="audits">Audits and testing</h2>
        <p>
          VisionSwap's program, circuit, server and apps have been tested extensively, including through an internal security review, but
          they have <strong>not yet had an independent audit</strong>. An independent security audit is on our{" "}
          <a href="/roadmap">roadmap</a>. When one is done, we plan to publish its report, its scope, the version of the code it covered and
          what was fixed. Until then, treat VisionSwap as new software.
        </p>

        <h2 id="report">Reporting a security problem</h2>
        <p>
          If you find a vulnerability, please tell us privately before telling anyone else, and give us a reasonable time to fix it.{" "}
          {security ? (
            <>
              Report it to{" "}
              <a href={security} target={security.startsWith("http") ? "_blank" : undefined} rel="noreferrer noopener">
                {security.replace(/^mailto:/i, "")}
              </a>
              . The same address is in our{" "}
              <a href="/.well-known/security.txt" target="_blank" rel="noreferrer noopener">
                security.txt
              </a>
              .
            </>
          ) : (
            <>Send a direct message to {x} asking for a private channel, without the details, and we'll arrange one.</>
          )}
        </p>
        <ul>
          <li>
            <strong>In scope:</strong> the pool program and its zero-knowledge circuit, our server and its API, the website and app, the
            Chrome extension and the Android app.
          </li>
          <li>
            <strong>Out of scope:</strong> services we don't run (wallets, Solana itself, Jupiter and other providers), attacks that need a
            device that is already compromised, social engineering, and anything that disrupts the service for other people, such as denial of
            service or spam.
          </li>
          <li>
            <strong>Please:</strong> use only your own accounts and funds, with small amounts; never access, move, change or keep anyone
            else's data or funds (if showing the problem would need that, stop and describe it to us instead); and stop and tell us as soon
            as you have found it.
          </li>
          <li>
            <strong>Good faith:</strong> we won't take legal action against anyone who reports a vulnerability in good faith and follows these
            guidelines, and we're glad to credit you if you'd like to be named. This promise is ours alone: we can't make it for anyone
            else, and it doesn't cover taking or keeping funds.
          </li>
          <li>
            <strong>Rewards:</strong> there is no paid bug bounty at the moment.
          </li>
        </ul>

        <h2 id="incidents">If something goes wrong</h2>
        <ul>
          <li>Official updates come from this website and from {x}.</li>
          <li>
            What the team can do: pause new deposits, stop relaying payments, send waiting deposits back to the addresses they came from and,
            while the program is upgradeable, upgrade it.
          </li>
          <li>No setting lets anyone move or redirect the funds in the pool; an upgrade could change the program's rules, as described above.</li>
        </ul>

        <h2 id="safe">Staying safe</h2>
        <ul>
          <li>
            Use VisionSwap only at visionswap.net, through the Android app downloaded from visionswap.net, or through the VisionSwap extension
            in the Chrome Web Store. Check the address bar before you connect.
          </li>
          <li>
            When your wallet asks you to sign, check that it names visionswap.net. The message that opens your account doesn't name the site,
            so only ever sign it on visionswap.net: anyone who has that signature can spend your private balance.
          </li>
          <li>
            Never share your wallet's recovery phrase or secret key, your VisionSwap private key or backup key, or the signature your wallet
            makes for VisionSwap, with anyone, whatever they tell you.
          </li>
          <li>
            VisionSwap's email addresses are <a href={mailto(SUPPORT_EMAIL)}>{SUPPORT_EMAIL}</a> and{" "}
            <a href={mailto(BUSINESS_EMAIL)}>{BUSINESS_EMAIL}</a>. Be wary of messages from other addresses that use VisionSwap's name, and
            never send keys, recovery phrases or signatures by email: we never ask for them.
          </li>
          <li>Turn on "Keep me signed in" only on a device only you use, and keep your browser and wallet up to date.</li>
          <li>
            Some records live only on your device, such as payments from your wallet waiting to go and your activity list. Clearing the site's
            data deletes them; your private balance stays on Solana and opens again with your keys.
          </li>
          <li>
            Check every address and amount before you confirm, and be wary of tokens and accounts that use VisionSwap's name. For your
            privacy, wait between steps, vary your amounts, and never send back to the wallet you deposited from.
          </li>
        </ul>
      </main>
      <Footer />
    </div>
  );
}
