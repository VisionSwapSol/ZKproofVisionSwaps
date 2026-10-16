import { Fragment } from "react";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import { FAQ_GROUPS } from "../lib/faq";
import { SOCIAL } from "../lib/config";
import { SUPPORT_EMAIL, mailto } from "../lib/contacts";
import { PAGES, longDate } from "../seo/pages";

/** A paragraph, with `backticked` words shown as code. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

export default function FaqPage() {
  return (
    <div className="page prose-page">
      <Header />
      <main className="wrap docs faq-page">
        <aside className="docs-nav">
          <p className="eyebrow">FAQ</p>
          <nav aria-label="Questions">
            {FAQ_GROUPS.map((g) => (
              <a key={g.id} href={`#${g.id}`}>
                {g.title}
              </a>
            ))}
            <a href="/support">More in Support</a>
            <a href="/docs">The full Docs</a>
          </nav>
        </aside>
        <article className="prose">
          <h1>Private SOL transfers, answered.</h1>
          <p className="lede">
            Plain answers about sending SOL privately on Solana with VisionSwap: how the shielded pool works, what stays private and what
            is public, what it costs, and how to check it for yourself.
          </p>
          <p className="muted faq-updated">Last updated {longDate(PAGES.faq.updated)}.</p>
          {FAQ_GROUPS.map((g) => (
            <section key={g.id} aria-labelledby={g.id}>
              <h2 id={g.id}>{g.title}</h2>
              {g.items.map((qa) => (
                <div key={qa.id} className="faq-item">
                  <h3 id={qa.id}>{qa.q}</h3>
                  {qa.a.map((p, i) => (
                    <p key={i}>
                      <Words text={p} />
                    </p>
                  ))}
                  {qa.steps && (
                    <ol>
                      {qa.steps.map((s, i) => (
                        <li key={i}>
                          <Words text={s} />
                        </li>
                      ))}
                    </ol>
                  )}
                  {qa.more?.map((p, i) => (
                    <p key={i}>
                      <Words text={p} />
                    </p>
                  ))}
                  {qa.links && (
                    <p className="faq-links">
                      {qa.links.map((l) => (
                        <a key={l.href} href={l.href}>
                          {l.label} →
                        </a>
                      ))}
                    </p>
                  )}
                </div>
              ))}
            </section>
          ))}
          <h2 id="more">Still have a question?</h2>
          <p>
            The <a href="/support">Support library</a> answers questions about each step in the app, and the <a href="/docs">Docs</a>{" "}
            explain how every part of VisionSwap works. You can also email <a href={mailto(SUPPORT_EMAIL)}>{SUPPORT_EMAIL}</a>, and
            follow{" "}
            <a href={SOCIAL.x} target="_blank" rel="noreferrer noopener">
              @VisionSwapSol on X
            </a>{" "}
            for news.
          </p>
        </article>
      </main>
      <Footer />
    </div>
  );
}
