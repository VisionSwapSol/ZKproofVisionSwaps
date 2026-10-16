import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { Restricted, useRegion } from "../components/Restricted";

/**
 * /unavailable: the restricted-region notice as a page of the site (noindex). The server's own answer for
 * /app, /pay and the Android download from a restricted place is a plain, script-free page in the same
 * words (sent with HTTP 451, the same for every user agent); this
 * page shows the same notice inside the site's frame, with the place the server names. It names where
 * the list is and nothing else. Someone the server doesn't place in a restricted place, who opens
 * /unavailable itself, reads what the page is instead of being told it applies to them.
 */
export default function UnavailablePage() {
  const info = useRegion();
  const notHere = !info.restricted && info.regionBlocking !== null;
  return (
    <div className="page prose-page unavailable-page">
      <Header />
      <main className="wrap app-main">
        {notHere ? (
          <section className="restricted" aria-labelledby="restricted-title">
            <h1 id="restricted-title" tabIndex={-1}>
              Where VisionSwap isn't available
            </h1>
            <p>
              VisionSwap isn't offered in some places, listed in the <a href="/terms#eligibility">Terms of use, section 2</a>, and on the{" "}
              <a href="/compliance#places">Compliance</a> page. Where it isn't offered, the app shows a notice like this one instead.
            </p>
          </section>
        ) : (
          <Restricted info={info} heading="h1" alwaysCredit />
        )}
      </main>
      <Footer />
    </div>
  );
}
