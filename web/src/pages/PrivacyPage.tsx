import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { SOCIAL } from "../lib/config";
import { shownLegal, useLegal } from "../legal/useLegal";
import { contactHref, contactText } from "../legal/settings";
import { BUSINESS_EMAIL, SUPPORT_EMAIL, mailto } from "../lib/contacts";

/**
 * The privacy policy for the website, the Android app and the Chrome extension. Every sentence here has
 * to stay true to the code: what the browser keeps (lib/device.ts, lib/idb.ts), what the server receives
 * and keeps (the VisionSwap service's own code), what the Android app asks for (no permissions, no
 * notifications) and what the extension asks for
 * (extension/scripts/manifest.mjs). Change them together: web/test/claims.test.ts checks the kept-for
 * figures below against the server's own constants.
 */

/** One row of a list: a name, what it covers, and how long it is kept. */
function Row({ name, kept, children }: { name: string; kept: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>
        <p>{children}</p>
        <span>{kept}</span>
      </dd>
    </div>
  );
}

export default function PrivacyPage() {
  // who is responsible: the operator's legal settings once set, never invented here; where
  // requests go: LEGAL_CONTACT, support@visionswap.net unless the owner names another (the default until /api/legal answers)
  const legal = shownLegal(useLegal()).legal;
  const contact = contactHref(legal.contact);
  const reach = contact ? (
    <a href={contact} target={contact.startsWith("http") ? "_blank" : undefined} rel="noreferrer noopener">
      {contactText(legal.contact)}
    </a>
  ) : (
    <a href={SOCIAL.x} target="_blank" rel="noreferrer noopener">
      @VisionSwapSol on X
    </a>
  );
  return (
    <div className="page prose-page">
      <Header />
      <main className="wrap prose terms">
        <h1>Privacy policy</h1>
        <p className="muted">Last updated October 15, 2026. This policy covers the website at visionswap.net, the VisionSwap app for Android and the VisionSwap extension for Chrome.</p>

        <div className="keypoints">
          <p>The main points</p>
          <ul>
            <li>Your spending and viewing keys are made and kept in your browser. We never receive them.</li>
            <li>
              Using VisionSwap needs no sign-up, name or email address, and there are no analytics, ads or trackers. The website, the Android app and the
              extension load nothing from third parties: your browser talks only to visionswap.net, and section 5 lists the services our
              server uses on your behalf.
            </li>
            <li>
              Like any website, our server sees the requests your browser sends it, and the addresses in them. VisionSwap's software writes
              no IP addresses or wallet addresses to its logs; the few records it keeps, and for how long, are listed in section 3.
            </li>
            <li>
              Solana is public: deposits, payments as they arrive and everything a Vision wallet does can be seen by anyone (section 6).
            </li>
            <li>We don't sell your data or share it for advertising, and we never will.</li>
          </ul>
        </div>

        <h2>1. What stays on your device</h2>
        <p>
          <strong>Your keys.</strong> Your browser makes your account's keys from your wallet's signature, your passkey or your VisionSwap private
          key, and your spending and viewing keys never leave it. The one key that does is an order's own single-purpose key, which our
          server holds while the order runs (section 2). If you choose "Keep me signed in", your browser keeps your private key sealed with a key it made itself
          and can't hand out, so the saved copy opens only in that browser.
        </p>
        <p>
          <strong>Your history.</strong> Your activity list, the payment links you made, scheduled payments, orders, names you gave Vision
          wallets and a copy of the pool's public data are kept in your browser's storage for the website (or the extension's own storage, for
          the extension). Nothing in this list is sent to us. "Sign out and clear history" removes an account's history from that browser;
          clearing the site's data, or removing the extension, removes everything.
        </p>
        <p>
          <strong>Your acceptance of the Terms.</strong> When you accept the <a href="/terms">Terms of use</a>, your browser (or the extension)
          keeps a record of the version you accepted, when, which boxes you ticked, the fingerprint of the text you were shown, a
          fingerprint of the operator's legal settings at the time, and whether it was the website, the Android app or the extension. It
          holds no wallet address or anything else about you, it is never sent to us, and accepting makes no request to our server. You can
          see, save or remove your browser's record at the end of the Terms page (the extension's is removed with the extension); removing
          it only means you are asked to accept the Terms again.
        </p>

        <h2>2. What our server receives</h2>
        <p>Everything the app needs from the network goes through our server, so the services behind it never see your IP address. Our server receives:</p>
        <ul>
          <li>Your connection, like any website: your IP address and browser details such as its name and version.</li>
          <li>
            Where your connection comes from: while region checks are on, our server looks your IP address up in a location database kept
            on the server (nothing is sent anywhere for it), to refuse requests from places where VisionSwap isn't offered. It uses the
            answer for that request only and keeps no location for any connection; refusals are counted, by month (section 3).
          </li>
          <li>
            With requests your app makes once you've accepted the Terms of use: the major version you accepted (for example 2), the same for
            everyone who accepted that version, and nothing else from your acceptance record.
          </li>
          <li>
            The public sanctions list: your app downloads it, the same file for everyone, and checks your connected wallet and the addresses
            you type against it in your browser. Nothing about those checks is sent to us.
          </li>
          <li>
            Requests for the pool's public data. Everyone downloads the same data and your browser finds its own notes in it, so these
            requests don't tell the server which notes are yours. That data includes the pool's public address list (every address that
            has deposited, been paid by the pool or paid for one of its payments, read from Solana), in which your app finds the
            addresses your account used before, on any device, without asking about each one.
          </li>
          <li>
            Solana requests your app makes: the balances and history of your own addresses (your deposit addresses, Vision wallets,
            one-time sending addresses, fee wallets and connected wallet), a new one just before its first use, and the transactions you
            submit. Arriving together from one connection, these show our server which addresses belong to one account. When you check
            all your sending addresses, they are read mixed with others from the public address list.
          </li>
          <li>
            When you shield: the depositing address, so it can be screened (section 4). Asking us to add a ready deposit to the pool, or
            to send one back, names that deposit.
          </li>
          <li>
            Payments you ask the relayer to send: the proof, the recipient, the amount and the fee, which become public on Solana when the
            payment goes. A payment scheduled for later is stored encrypted until it goes out. For a payment to an outside address, its
            one-time sending address, recipient and amount are kept while the delivery is open. Section 3 says for how long.
          </li>
          <li>
            Orders you place (limit buys, DCA, take-profit, stop-loss): their terms, the Vision wallet and the order's own key, stored
            encrypted while the order runs. When it ends, its key is deleted from our records.
          </li>
          <li>
            Status checks: your app learns how your scheduled payments and orders are doing from a status board listing everyone's, each
            entry sealed so that, of everyone who downloads the board, only the app that made the payment or order can read it. It
            downloads the whole board, or once the board is large a part of it that holds many other entries too, and picks out its
            own, so a check doesn't name yours. Deliveries are found the same way, in the public list of sending addresses holding SOL,
            where each one's record is sealed to that address's own key.
          </li>
          <li>Trades: the token, the amount and the Vision wallet a swap is built for.</li>
          <li>Token searches, token icons and prices you look at, and any address you type into the Exposure check.</li>
        </ul>

        <h2>3. Logs and how long things are kept</h2>
        <p>
          VisionSwap's software never writes IP addresses, wallet addresses or amounts to its logs, and blanks out anything in a log line that
          looks like an address, a transaction ID or an IP address. What it does keep:
        </p>
        <dl className="proof">
          <Row name="Fair-use counters" kept="In memory only, gone when the wait ends (after a day, for the counts kept by a note's spend IDs or a depositing address) or the server restarts.">
            How many requests each IP address made in the last minute, and how many chain reads each network's deposit checks used;
            while a scheduled payment or a new order waits, which network it came from, so that no one network can take every place;
            by the notes' spend IDs (which become public when the payment goes), how many times the same notes were scheduled in the
            last day, how often a proof for them was checked in the last hour, and whether one was checked in the last day, so that no
            one can fill the schedule or the proof checker by sending the same notes again; and how many free take-backs each
            depositing address had in the last day.
          </Row>
          <Row name="Scheduled payments" kept="Until it goes out or you cancel it; then its outcome for 2 days (7 days for one waiting for your app to make a fresh proof).">
            The payment, encrypted: its proof, recipient, amount and when it should go.
          </Row>
          <Row name="Deliveries" kept="While the delivery is open, and 2 days after; one waiting for your app to finish it, up to 30 days.">
            For a payment to an outside address: its one-time sending address, the recipient, the amount and the transactions sent.
          </Row>
          <Row name="Sending addresses" kept="Up to 400 days, then deleted (the oldest go sooner if more than 250,000 are kept).">
            The one-time sending addresses of deliveries, and the recipients of payments your app sent itself (which can be your own
            wallets), with the date, so that SOL an exchange returns to one months later is still found for you. They are public on
            Solana anyway; nothing else is kept with them.
          </Row>
          <Row name="Orders" kept="While the order runs; its key is deleted when it ends, and a short record of how it ended is kept for 14 days. An order never confirmed is dropped after 10 minutes.">
            The order, encrypted: its terms, the Vision wallet and the order's key.
          </Row>
          <Row name="Screening" kept="In memory only, at most until the server restarts: funding lists for the latest 5,000 addresses screened, and Range's answers, reused for up to 1 hour.">
            Which wallets recently paid into an address that was screened, and the answers, so the same address isn't looked up twice.
          </Row>
          <Row name="Exposure checks" kept="In memory only: reused for 5 minutes, and gone once 500 newer checks have been made or the server restarts.">
            The result for an address you checked, so asking twice doesn't look it up twice.
          </Row>
          <Row name="Monthly totals" kept="Kept as monthly counts, and published on the Compliance page.">
            How many deposits were screened and sent back, how many recipients were refused, and how many requests were refused because of
            where they came from, for each month: counts only, never an address, an IP address or anything about one person.
          </Row>
          <Row name="Records we can't open" kept="Kept, still encrypted, for 30 days, then deleted.">
            If the server's own encryption key is ever changed, saved payments, deliveries and orders it can no longer open are set aside,
            still encrypted, so the old key could recover them in that time.
          </Row>
        </dl>
        <p>Our hosting provider keeps its own records of the connections it receives, under its own policies (section 5).</p>
        <p>
          <strong>Emails you send us.</strong> If you write to <a href={mailto(SUPPORT_EMAIL)}>{SUPPORT_EMAIL}</a> or{" "}
          <a href={mailto(BUSINESS_EMAIL)}>{BUSINESS_EMAIL}</a>, we receive your email address, your message and anything you attach,
          through our email provider, which keeps them under its own policies. We use them only to answer you and to deal with what you
          asked, keep them only as long as that needs, and never add you to a mailing list. Please leave keys, recovery phrases and
          signatures out of every message: we never need them.
        </p>

        <h2>4. Deposit screening</h2>
        <p>
          Every deposit is screened before it joins the pool: the depositing address, and the wallets that recently paid SOL into it, are
          checked against the U.S. sanctions (OFAC) list, which our server reads from OFAC's own published list, checking for updates every 6 hours (a public copy of the list is the fallback), and against the addresses we refuse. The
          recipient of every payment our relayer sends is checked against the same list. When it's switched on, Range, an address risk
          service, also receives these addresses from our server: depositors and the wallets that funded them, deposits checked again while
          they wait, and the recipients of relayed payments, your own Vision wallets included. Range then knows that VisionSwap asked about
          those addresses; it never receives your IP address. The Terms of use, section 5, explain what happens to a deposit that fails.
        </p>

        <h2>5. Who else is involved</h2>
        <p>
          Your browser reaches only our host and, on your device, your wallet app. The other services below work for us and receive
          requests from our server, never from your browser, so none of them learns your IP address from VisionSwap. Each keeps what it
          receives under its own policies.
        </p>
        <dl className="proof">
          <Row name="Replit" kept="Its own connection records, under Replit's policies.">
            Hosts the website and our server, on Google Cloud. Its front end receives every connection: your IP address, browser details,
            the page or request asked for (including anything in its address, such as an address you check) and the time.
          </Row>
          <Row name="Helius" kept="Under Helius's policies.">
            Our main Solana RPC provider. It answers the Solana requests in section 2 and sends the transactions: the addresses your app
            asks about, the transactions you submit and the public history of an address you check in the Exposure check. Requests that
            arrive together can show it that those addresses are looked at together.
          </Row>
          <Row name="Solana's public RPC" kept="Under its operator's policies.">
            api.mainnet-beta.solana.com, used only while our main provider is busy or unavailable. It then receives the same requests.
          </Row>
          <Row name="Jupiter" kept="Under Jupiter's policies.">
            Swap routes, prices and token lists: the tokens and amounts of quotes and trades, and the Vision wallet (or order key) each swap
            is built for, including the order service's trades and price checks.
          </Row>
          <Row name="Range" kept="Under Range's policies, when switched on.">
            Address screening, when it's switched on: the addresses in section 4.
          </Row>
          <Row name="Bonfida" kept="Under Bonfida's policies.">
            Its .sol name service (sns-sdk-proxy.bonfida.workers.dev) receives the address you type into the Exposure check, to look up its
            .sol name.
          </Row>
          <Row name="Token icon hosts" kept="Icons are cached on our server for a day.">
            The websites that host token icons receive our server's requests for those icons: which token, nothing about you.
          </Row>
          <Row name="U.S. Treasury (OFAC)" kept="Nothing about you is sent.">
            Our server downloads OFAC's published sanctions list from the U.S. Treasury's website.
          </Row>
          <Row name="GitHub" kept="Nothing about you is sent.">
            Our server fetches a public copy of the OFAC list from GitHub, used when OFAC's own file can't be read.
          </Row>
          <Row name="DB-IP" kept="Nothing is sent to it.">
            Our server downloads DB-IP's free IP location database (
            <a href="https://db-ip.com" target="_blank" rel="noreferrer noopener">
              IP Geolocation by DB-IP
            </a>
            , under its CC BY 4.0 licence) and looks connections up in its own copy: no IP address or request goes to DB-IP.
          </Row>
          <Row name="Your wallet app" kept="Under your wallet's own policy.">
            Sees what you ask it to sign and the site asking. Many wallets also send transactions to their own servers to check them before
            you approve.
          </Row>
        </dl>
        <p>
          Links you choose to open, such as a block explorer or our X account, take you to other sites with their own policies.
        </p>

        <h2>6. The public blockchain</h2>
        <p>
          These are public on Solana, permanently, for anyone to see: deposits (the depositing address, the amount and the time); private
          payments as they reach their recipients (the one-time sending address, the recipient, the amount and the time); the small
          transfers inside the pool that join or cut notes (recognisable as such, though not whose they are); how much the pool holds; and everything a
          Vision wallet does, from its funding out of the pool to its trades and its deposits back. Which deposit paid for which payment
          is in no transaction, but matching amounts and timing can sometimes suggest it, which is why the app encourages waiting and
          varying amounts. The Terms of use, section 9, set out what's private and what isn't.
        </p>

        <h2>7. The VisionSwap extension for Chrome</h2>
        <ul>
          <li>
            It runs the same app as the website, in Chrome's side panel, and handles your data exactly as sections 1 to 6 describe. It talks
            only to visionswap.net.
          </li>
          <li>
            It asks Chrome for two permissions: "side panel", to show itself in the side panel, and "storage", to hold an account you link from
            visionswap.net for up to two minutes, in memory only, until you open it or turn it down. Its access to visionswap.net is how it
            talks to our server.
          </li>
          <li>It doesn't read or change the web pages you visit, and it doesn't see your browsing history or your tabs.</li>
          <li>
            "Link to extension" on visionswap.net hands the account you have open to the extension directly inside your browser, through
            Chrome, never through a server. The extension takes it only from visionswap.net, and only after you press the button.
          </li>
        </ul>
        <p>
          The use of information received through the VisionSwap extension complies with the{" "}
          <a href="https://developer.chrome.com/docs/webstore/program-policies/user-data-faq" target="_blank" rel="noreferrer noopener">
            Chrome Web Store User Data Policy
          </a>
          , including the Limited Use requirements. We use it only to provide the extension's single purpose, private sends and private
          trading on Solana; we don't sell it, use it for advertising or credit decisions, or transfer it except as needed to provide that
          purpose or to comply with the law; and no person reads it unless you ask us to, for security, or as the law requires.
        </p>

        <h2>8. The VisionSwap app for Android</h2>
        <ul>
          <li>
            It is the VisionSwap website as an app: it opens visionswap.net full screen in your phone's browser and handles your data
            exactly as sections 1 to 6 describe. What it keeps on your phone sits in that browser's storage for visionswap.net.
          </li>
          <li>
            It asks Android for no permissions: no location, contacts, camera, microphone or notifications. It adds no analytics, ads or
            trackers of its own and collects nothing.
          </li>
          <li>
            Wallet apps on your phone connect to it directly on the phone, through the Mobile Wallet Adapter, and see what you ask
            them to sign.
          </li>
          <li>
            To confirm that the app belongs to visionswap.net, your browser reads a public file on our website
            (/.well-known/assetlinks.json), the standard way an app and a website vouch for each other, and Android confirms the app's
            visionswap.net links the same way, on most phones through Google's own services. The file describes the app, nothing about you.
            Android and Google Play Protect may also check the app when you install it, under Google's policies.
          </li>
        </ul>

        <h2>9. Your choices</h2>
        <ul>
          <li>Lock your account, sign out, or sign out and clear its history, any time, in the app or the extension.</li>
          <li>
            Clear the site's data in your browser settings (the Android app keeps its data there too), or remove the extension, to delete
            everything VisionSwap kept there.
          </li>
          <li>Remove your browser's record of accepting the Terms of use, at the end of the Terms page.</li>
          <li>
            For the strongest privacy, use a VPN or Tor, and shield and spend in different sittings. VPNs and Tor are for privacy, never
            for getting around the places where VisionSwap isn't offered (<a href="/terms#eligibility">Terms of use, section 2</a>).
          </li>
        </ul>

        <h2>10. Children</h2>
        <p>
          VisionSwap is for people 18 and older, or the age of majority where they live if that is higher. We don't knowingly receive
          anything from children.
        </p>

        <h2>11. Changes</h2>
        <p>When this policy changes, we update this page and the date at the top.</p>

        <h2>12. Who is responsible, and your rights</h2>
        <p>
          {legal.entity ? `${legal.entity} ("we")` : `The operator of VisionSwap ("we")`} is responsible for the personal data this policy
          describes. We use it to provide the services you ask for, to keep them secure and free of abuse, and to screen deposits and
          payments as section 4 describes. Our server and the services in section 5 may handle it outside the country where you live.
        </p>
        <p>
          Depending on where you live, you may have the right to ask what personal data we hold about you, to have it corrected or deleted,
          to object to or restrict how we use it, and to complain to your data protection authority. Because we never ask who you are, we
          may need you to tell us which address, payment or order a request is about. Most of what we keep is deleted on the schedule in
          section 3, and what is on Solana can't be changed or deleted by anyone.
        </p>

        <h2>13. Contact</h2>
        <p>Privacy questions and requests, including the rights in section 12: {reach}.</p>
      </main>
      <Footer />
    </div>
  );
}
