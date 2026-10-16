import type { Screening } from "../legal/info";
import { contactHref, contactText } from "../legal/settings";
import { FIGURE_COLUMNS, countText, monthName, type Transparency } from "../lib/transparency";

/**
 * Parts of the Compliance page that read what the server publishes: the screening policy (P0-7, from
 * /api/legal "screening") and the monthly figures (P1-4, from /api/transparency). No network and no
 * styles here, so the node tests can render them from a fixture.
 */

const SOURCE_TEXT: Record<NonNullable<Screening["source"]>, string> = {
  ofac: "from OFAC's own published file",
  mirror: "from a public copy of OFAC's file",
  seed: "from the copy built into our server",
};

/** "October 15, 2026" from an ISO time, in UTC (the same on every computer). */
function day(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

/** A link to the legal contact (support@visionswap.net by default), or null when the owner turned it off (no contact line is shown then). */
export function ContactLink({ contact }: { contact: string | null }) {
  const href = contactHref(contact);
  if (!href) return null;
  return (
    <a href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noreferrer noopener">
      {contactText(contact)}
    </a>
  );
}

/** The published screening policy (/compliance#policy). */
export function ScreeningPolicy({ screening, contact }: { screening: Screening | null; contact: string | null }) {
  const lists = screening?.lists.length ? screening.lists.join(", ") : "OFAC SDN";
  return (
    <>
      <ul>
        <li>
          <strong>Sources.</strong> The official U.S. sanctions list: the Solana addresses on the list of Specially Designated Nationals
          kept by the U.S. Treasury's Office of Foreign Assets Control (OFAC), read from OFAC's own published file and checked for updates
          every 6 hours, with a public copy of that file as the fallback. And our own list of addresses we refuse.
          {screening?.riskService && (
            <>
              {" "}
              An outside address risk service is switched on too and checks the same addresses; the <a href="/privacy">Privacy policy</a>,
              section 4, names it and says what it receives.
            </>
          )}
        </li>
        <li>
          <strong>Who is checked.</strong> The wallet making a deposit, and the wallets that paid SOL into it recently: one step back, as
          far as our server can read within its limits. For a deposit by QR code or payment link, the wallets that paid into your deposit
          address. A deposit whose balance can't be explained within those limits may be refused. Recipients are checked too.
        </li>
        <li>
          <strong>When.</strong> Before the screening pass a deposit needs; again shortly before a deposit can join the pool; at every
          payment our relayer sends; in our app, before <em>Send all</em> from a Vision wallet or a deposit address; and, against the
          sanctions list, for the transfers our server passes on to the network.
        </li>
        <li>
          <strong>Outcomes.</strong> A deposit that fails is refused before it is made or, once made, sent back only to the address it came
          from. While a deposit is under review, our app and servers won't add it to the pool. A refused recipient isn't paid.
        </li>
        {contact && contactHref(contact) && (
          <li>
            <strong>If you think we got it wrong.</strong> Write to <ContactLink contact={contact} /> with the address and the transaction.
            We'll review it, but we can't promise a different outcome or a reply by any particular time.
          </li>
        )}
        <li>
          <strong>Records.</strong> We keep no stored record of screening decisions about any address. Recent results are held in memory
          only, as the <a href="/privacy">Privacy policy</a>, section 3, describes, and the totals we publish each month are counts only.
        </li>
        <li>
          <strong>Limits.</strong> Screening is a careful filter, not proof: it looks a short way back into an address's public history,
          and payments made with software other than VisionSwap's can skip the checks our app and server make. Proving that a payment's
          source belongs to an approved set would need new circuits and a new trusted setup; the current setup stays in place for now.
        </li>
      </ul>
      {screening && (
        <p className="small">
          <span className="legal-status on">
            <i aria-hidden="true" /> Screening: {lists}
            {screening.riskService ? ", plus a risk service" : ""}
          </span>{" "}
          {screening.updatedAt
            ? `Our server's copy of the list was last updated ${day(screening.updatedAt)}${screening.source ? `, ${SOURCE_TEXT[screening.source]}` : ""}.`
            : screening.source
              ? `Our server's copy of the list comes ${SOURCE_TEXT[screening.source]}.`
              : ""}
        </p>
      )}
    </>
  );
}

/** The monthly figures (/compliance#figures). `data` null: not loaded (yet, or at all). */
export function Figures({ data, failed }: { data: Transparency | null; failed?: boolean }) {
  if (!data) return <p className="muted small">{failed ? "The figures can't be loaded right now. Please try again later." : "Loading the figures…"}</p>;
  if (!data.months.length) {
    return (
      <p className="muted small">
        {data.since ? `Figures are counted from ${monthName(data.since)}. ` : ""}The first month's totals appear here once there is something
        to count.
      </p>
    );
  }
  return (
    <div className="figures-wrap">
      <table className="figures">
        <caption className="sr-only">VisionSwap's monthly screening figures</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            {FIGURE_COLUMNS.map(([k, label]) => (
              <th scope="col" key={k}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.months.map((m) => (
            <tr key={m.month}>
              <th scope="row">{monthName(m.month)}</th>
              {FIGURE_COLUMNS.map(([k]) => (
                <td key={k}>{countText(m[k])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tiny">
        {data.since ? `Counted from ${monthName(data.since)}. ` : ""}Counts only: no addresses, amounts or anything about any one person. A
        count from 1 to 4 shows as "fewer than 5".
        {data.months[0].month === new Date().toISOString().slice(0, 7) ? ` ${monthName(data.months[0].month)} is still being counted.` : ""}
      </p>
    </div>
  );
}
