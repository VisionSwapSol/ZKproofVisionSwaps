import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Icon } from "../components/Icon";
import { ContactLink, Figures, ScreeningPolicy } from "../components/ComplianceParts";
import { api } from "../lib/net";
import { measuredMsPerSlot, slotsToText } from "../lib/slottime";
import { parseTransparency, type Transparency } from "../lib/transparency";
import { refusedPlaces, shownLegal, useLegal } from "../legal/useLegal";
import { GEO_ATTRIBUTION, RESTRICTED_SENTENCE, andList, placeName } from "../legal/places";
import { PAGES, longDate } from "../seo/pages";
import "../styles/legal.css";

/**
 * Compliance: what VisionSwap checks and when, the published screening policy, what happens to flagged
 * funds, where it isn't offered, monthly figures, the sanctions compliance programme in short, and how
 * requests from authorities are handled. Every sentence has to stay true to the code (the VisionSwap
 * service's screening, guard, relayer, RPC gateway and region checks; the Privacy policy's retention
 * list) and to how VisionSwap runs today; web/test/claims.test.ts and compliance.test.ts scan it. Region
 * blocking and the screening sources are described as /api/legal reports them, and nothing about how
 * screening works inside (what it caches, how it is tuned) belongs here.
 */

type Info = { minDeposit: string; maxDeposit: string; tvlCap?: string; depositDelaySlots: string; msPerSlot?: number; requireAttestation?: boolean };

/** More SOL than exists: how the program's settings say "no limit". */
const UNLIMITED = 10n ** 18n;
const sol = (l: string) => (Number(l) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

/** The deposit limits exactly as the program's settings hold them right now. */
function limitsNow(i: Info): string {
  const max = BigInt(i.maxDeposit) >= UNLIMITED ? "there is no largest single deposit" : `the largest single deposit is ${sol(i.maxDeposit)} SOL`;
  const cap =
    i.tvlCap == null ? "" : BigInt(i.tvlCap) === 0n || BigInt(i.tvlCap) >= UNLIMITED ? ", and there is no cap on the pool's size" : `, and the pool holds at most ${sol(i.tvlCap)} SOL`;
  return `Right now, deposits start at ${sol(i.minDeposit)} SOL, ${max}${cap}.`;
}

const SECTIONS: [string, string][] = [
  ["approach", "Our approach"],
  ["checks", "What we check, and when"],
  ["policy", "Our screening policy"],
  ["waiting", "The waiting room"],
  ["flagged", "Flagged deposits"],
  ["limits", "Deposit limits"],
  ["places", "Restricted places"],
  ["prohibited", "Prohibited use"],
  ["records", "Records you can share"],
  ["figures", "Monthly figures"],
  ["programme", "Our sanctions compliance programme"],
  ["requests", "Requests from authorities"],
  ["yours", "Your responsibilities"],
];

export default function CompliancePage() {
  const legal = useLegal();
  const [info, setInfo] = useState<Info | null>(null);
  const [figures, setFigures] = useState<{ data: Transparency | null; failed: boolean }>({ data: null, failed: false });
  useEffect(() => {
    api<Info>("/api/pool/info").then(setInfo).catch(() => {});
    api<unknown>("/api/transparency")
      .then((j) => {
        const data = parseTransparency(j);
        setFigures({ data, failed: !data });
      })
      .catch(() => setFigures({ data: null, failed: true }));
  }, []);
  const wait = info ? slotsToText(info.depositDelaySlots, measuredMsPerSlot(info.msPerSlot, null)) : null;
  const refused = refusedPlaces(legal);
  const blocking = legal?.regionBlocking === "on" && refused.length > 0;
  // LEGAL_CONTACT: support@visionswap.net unless the owner names another (the default until /api/legal answers)
  const contact = shownLegal(legal).contact;
  return (
    <div className="page prose-page">
      <Header />
      <main className="wrap prose terms">
        <h1>Compliance</h1>
        <p className="lede">
          VisionSwap is built for people protecting ordinary, lawful money. This page explains what we check and when, what happens to
          flagged funds, where VisionSwap isn't offered, and what information exists about the people who use it.
        </p>
        <p className="muted">Last updated {longDate(PAGES.compliance.updated)}.</p>

        <div className="legal-cards">
          <div className="legal-card">
            <Icon name="shield" size={22} />
            <strong>Screened at the door</strong>
            <p>Every depositing wallet, and the wallets that recently funded it, is checked against the U.S. sanctions list before a deposit.</p>
          </div>
          <div className="legal-card">
            <Icon name="clock" size={22} />
            <strong>A public waiting room</strong>
            <p>Each deposit waits in the open before it joins the pool, and is checked again.</p>
          </div>
          <div className="legal-card">
            <Icon name="undo" size={22} />
            <strong>Returns only to the source</strong>
            <p>A flagged deposit that is sent back can only go to the address that made it. The program allows nothing else.</p>
          </div>
          <div className="legal-card">
            <Icon name="doc" size={22} />
            <strong>Records you can share</strong>
            <p>Download a statement of your notes for an exchange or an accountant, or sign an exchange's message to show an address is yours.</p>
          </div>
        </div>

        <ul className="legal-toc" aria-label="On this page">
          {SECTIONS.map(([id, t]) => (
            <li key={id}>
              <a href={`#${id}`}>{t}</a>
            </li>
          ))}
        </ul>

        <h2 id="approach">Our approach</h2>
        <p>
          Financial privacy is normal: salaries, savings and payments shouldn't be on public display. VisionSwap is self-custody software that
          gives people that privacy on Solana, and it is not a way to hide crime. We don't ask for names or identity documents. Instead, we
          screen the addresses that money comes from and goes to, hold every deposit in a public waiting room before it joins the pool, and
          send flagged deposits back only to where they came from. Payments made with other software can skip the checks our app and server
          make. Using VisionSwap for anything unlawful is against our <a href="/terms#prohibited">Terms of use</a>.
        </p>
        <p>
          No screening catches everything, and ours can be wrong in either direction. It makes it harder for unlawful money to get into the
          pool; it can't prove that everything in the pool came from a lawful source.
        </p>

        <h2 id="checks">What we check, and when</h2>
        <ul>
          <li>
            <strong>Before a deposit.</strong> The depositing wallet, and the wallets that recently paid SOL into it, are checked against the
            U.S. sanctions list, which our server reads from OFAC's own published list (a public copy of it is the fallback), and against
            the addresses we refuse. For a deposit by QR code or payment link, the wallets that paid into your deposit address are checked. A
            deposit whose funds can't be traced back far enough may be refused. Only then does our screening service sign the short-lived
            pass that the program's settings require before it accepts a deposit.
          </li>
          <li>
            <strong>While a deposit waits.</strong> It is checked again before it joins the pool.
          </li>
          <li>
            <strong>When money leaves.</strong> Our relayer checks the recipient of every private payment it sends against the same lists, and
            won't pay a refused address. In our app, <em>Send all</em> from a Vision wallet or a deposit address checks the recipient first,
            and the transfers our server passes on to the network are checked against the sanctions list.
          </li>
          <li>
            <strong>When you connect a wallet.</strong> The app checks the wallet's address against the published sanctions list in your
            browser, before any account opens; nothing about that check is sent to us.
          </li>
          <li>
            <strong>Addresses only.</strong> Screening looks at addresses and their public history on Solana, never at names or ID. The{" "}
            <a href="/privacy">Privacy policy</a> says which services receive which addresses.
          </li>
        </ul>
        {info?.requireAttestation === false && (
          <p>
            <span className="legal-status">
              <i aria-hidden="true" /> Screening pass off
            </span>{" "}
            Right now the program's settings don't require a screening pass, so deposits aren't checked before they are made.
          </p>
        )}

        <h2 id="policy">Our screening policy</h2>
        <ScreeningPolicy screening={legal?.screening ?? null} contact={contact} />

        <h2 id="waiting">The waiting room</h2>
        <p>
          Every deposit waits in a public waiting room before it joins the pool
          {wait ? `: right now, for ${/^about /.test(wait) ? wait : `about ${wait}`}` : ", for a time shown in the app"}.
          The program caps that time at 1,512,000 Solana slots, about three and a half days at Solana's slot time when this page was last
          updated. While a deposit waits, it isn't part of anyone's private balance, and the person who made it can take it back at any time,
          deposit fee included, but only to the address it came from.
        </p>

        <h2 id="flagged">Flagged deposits</h2>
        <ul>
          <li>A deposit that fails screening can be stopped before it is sent: while its settings require a pass, the program won't accept a deposit without one.</li>
          <li>
            A deposit flagged while it waits can be sent back, deposit fee included, and only ever to the address that made it: the program
            allows nothing else. While it is reviewed, our app and servers won't add it to the pool.
          </li>
          <li>SOL at a deposit address that fails screening isn't moved into the pool and stays at that address.</li>
          <li>An address that fails screening once may be refused again, as a depositor and as a recipient.</li>
          {contact && (
            <li>
              Think we got it wrong? Write to <ContactLink contact={contact} /> with the depositing address and the transaction. We'll review
              it, but we can't promise a different outcome or a reply by any particular time.
            </li>
          )}
          {contact && (
            <li>
              <strong>Report stolen funds.</strong> Write to <ContactLink contact={contact} /> with the addresses and transactions involved.
              After a review we may add addresses to the list we refuse, so that new deposits and payments involving them are refused. That
              can't reach funds already in the pool.
            </li>
          )}
        </ul>

        <h2 id="limits">Deposit limits</h2>
        <p>
          The program's settings cap the size of a single deposit and of the whole pool. When this page was last updated, they were 300 SOL
          per deposit and 30,000 SOL for the pool. {info ? limitsNow(info) : ""} The VisionSwap team can change these settings, as the{" "}
          <a href="/terms#control">Terms of use, section 8</a>, explain.
        </p>

        <h2 id="places">Restricted places</h2>
        <p>
          VisionSwap is not offered to anyone on a sanctions list of the United Nations, the United States, the European Union or the United
          Kingdom, or to anyone acting for one. It is not for anyone who is in, lives in, or is a company formed in {RESTRICTED_SENTENCE}; any
          other place under comprehensive sanctions of those bodies; or any place where using a privacy tool is against the law. Using
          VisionSwap from these places isn't permitted under the <a href="/terms#eligibility">Terms of use, section 2</a>, and using a VPN or
          anything else to get around that is a breach of them.
        </p>
        {blocking && (
          <>
            <p>
              <span className="legal-status on">
                <i aria-hidden="true" /> Region checks on
              </span>{" "}
              Our server also refuses the app, deposits, private payments and trades to connections from {andList(refused.map(placeName))},
              and deposits from connections whose location can't be told.
            </p>
            <p className="small">
              It looks each connection up itself, in a location database kept on our server: nothing is sent to anyone else, and no
              connection's location is kept, only the monthly totals below. Locations from IP addresses can be wrong, and a region within a
              country is harder to place than the country. Data:{" "}
              <a href={GEO_ATTRIBUTION.href} target="_blank" rel="noreferrer noopener">
                {GEO_ATTRIBUTION.text}
              </a>
              .
            </p>
          </>
        )}

        <h2 id="prohibited">Prohibited use</h2>
        <p>
          Nobody may use VisionSwap to launder the proceeds of crime, finance terrorism, evade sanctions, move stolen or extorted funds, or use
          money that isn't lawfully theirs, or help anyone else do so. We may refuse or hold any deposit or payment, and send a deposit back
          (only ever to the address that made it), that we reasonably believe breaks these rules. The full list is in the{" "}
          <a href="/terms#prohibited">Terms of use, section 11</a>.
        </p>

        <h2 id="records">Records you can share</h2>
        <p>
          Exchanges, banks and accountants may ask where funds came from. In the app, <strong>Your records</strong> downloads a statement of
          your private notes. Whoever you give it to can check that each note exists on-chain and, for notes that came straight from a
          deposit, which wallet made it. It can't spend anything, and it doesn't prove which notes are still unspent, that the list is
          complete, or that you control the account. You can include your viewing key, which lets the holder see every note you've received,
          before and after today, and can't be taken back, so share it only with someone you trust.
        </p>
        <p>
          To show an exchange that an address is yours, the app can sign the exchange's message with it: a Vision wallet, a deposit address
          or the wallet you connected. The exchange can check the signature on our <a href="/verify">Check an ownership proof</a> page or
          with its own tools. The free <a href="/check">Exposure check</a> shows what any wallet's public history gives away.
        </p>

        <h2 id="figures">Monthly figures</h2>
        <p>
          Each month we publish how many deposits were screened, how many were sent back, how many recipients were refused and how many
          requests were refused because of where they came from: totals only, never addresses or amounts.
        </p>
        <Figures data={figures.data} failed={figures.failed} />

        <h2 id="programme">Our sanctions compliance programme</h2>
        <p>
          We keep a written sanctions compliance programme, built on the five parts the U.S. Treasury's Office of Foreign Assets Control
          describes: commitment from the people who run VisionSwap, an assessment of the risks a privacy tool faces, the controls on this
          page, regular testing that they work, and training for anyone who answers users. In short:
        </p>
        <ul>
          <li>
            <strong>Risks we plan for.</strong> Sanctioned people and places, including groups known to use mixing services, and stolen or
            extorted funds.
          </li>
          <li>
            <strong>Controls.</strong> Screening when money comes in and goes out, the waiting room, returns only to the source, region
            checks and the Terms of use.
          </li>
          <li>
            <strong>Testing.</strong> The programme sets a monthly check that listed addresses are refused and that region checks answer as
            they should.
          </li>
          <li>
            <strong>Support.</strong> We never suggest a way around a restriction, and we stop helping anyone who tells us they are in a
            restricted place.
          </li>
          <li>
            <strong>Review.</strong> The programme is reviewed at least once a year, and whenever the rules that apply to it change.
          </li>
        </ul>

        <h2 id="requests">Requests from authorities</h2>
        <p>
          We review requests from law-enforcement and other authorities and respond as the law requires.
          {contact && (
            <>
              {" "}
              Send them to <ContactLink contact={contact} />.
            </>
          )}{" "}
          Because VisionSwap is self-custody software, what we hold is limited:
        </p>
        <ul>
          <li>
            We never receive anyone's spending or viewing keys, so we can't open anyone's private balance or spend from it.
          </li>
          <li>We don't ask for names or identity documents, so we have none to give.</li>
          <li>
            What our server keeps, and for how long, is listed in the <a href="/privacy">Privacy policy</a>, section 3: for example scheduled
            payments, deliveries, one-time sending addresses and orders, stored encrypted where the policy says so. Requests to settle or
            refund a deposit name that deposit, and requests to relay a payment carry its proof, its recipient, its amount and the spend IDs
            of the notes it uses, which become public when it goes.
          </li>
          <li>
            VisionSwap's software writes no IP addresses or wallet addresses to its logs. Our hosting provider keeps its own connection
            records, under its own policies.
          </li>
          <li>Deposits, payouts and everything a Vision wallet does are public on Solana for anyone to see.</li>
          <li>
            What we can do: refuse deposits and payments, send waiting deposits back to the addresses they came from, add addresses to the
            list we refuse, and pause new deposits. No setting lets us move or redirect funds in the pool. The{" "}
            <a href="/terms#control">Terms of use, section 8</a>, set out what the VisionSwap team can change in the program, including by
            upgrading it.
          </li>
        </ul>

        <h2 id="yours">Your responsibilities</h2>
        <ul>
          <li>Know and follow the laws that apply to you, including the rules on privacy tools and digital assets where you live.</li>
          <li>Work out, report and pay any tax on your activity. Keep your own records; a statement from the app can help.</li>
          <li>
            Exchanges and other services may ask about, hold or turn away funds that have been through a privacy tool. Expect questions, and
            be ready to show where your money came from.
          </li>
        </ul>
        <p>
          Nothing on this page is legal, tax or compliance advice, and the <a href="/terms">Terms of use</a> take priority over it.
        </p>
      </main>
      <Footer />
    </div>
  );
}
