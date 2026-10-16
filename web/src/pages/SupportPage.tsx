import { useMemo, useState } from "react";
import { SUPPORT_CATEGORIES, SUPPORT_FAQS } from "../lib/support-faq";
import { SOCIAL } from "../lib/config";
import { SUPPORT_EMAIL, mailto } from "../lib/contacts";
import { contactText } from "../legal/settings";
import { shownLegal, useLegal } from "../legal/useLegal";
import { Header } from "../components/Header";
import { Footer } from "../components/Footer";
import "../styles/support.css";

export default function SupportPage() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  // BUSINESS_CONTACT: business@visionswap.net unless the owner names another (the default until /api/legal answers)
  const business = shownLegal(useLegal()).business;

  const filteredFaqs = useMemo(
    () =>
      SUPPORT_FAQS.filter((faq) => {
        const matchesCategory = category === "all" || faq.category === category;
        const searchable = `${faq.question} ${faq.answer}`.toLocaleLowerCase();
        return matchesCategory && (!normalizedQuery || searchable.includes(normalizedQuery));
      }),
    [category, normalizedQuery],
  );

  const resetFilters = () => {
    setQuery("");
    setCategory("all");
    setExpanded(null);
  };

  return (
    <>
      <Header />
      <main className="support-page">
        <section className="support-hero" aria-labelledby="support-title">
          <div className="wrap support-hero-inner">
            <div>
              <p className="eyebrow">VisionSwap / Support</p>
              <h1 id="support-title">A clearer way to <em>get help.</em></h1>
              <p className="support-hero-copy">
                Start with the answers below, or write to the VisionSwap team. Find guidance for private sends,
                fresh-wallet trading, and using the app.
              </p>
            </div>
            <aside className="support-contact" id="contact" aria-labelledby="support-contact-title">
              <span className="support-contact-kicker">Need a hand?</span>
              <h2 id="support-contact-title">Email the VisionSwap team.</h2>
              <p>For help with the app, your account or a payment, and for legal, compliance, security and privacy requests, write to:</p>
              <a className="support-mail" href={mailto(SUPPORT_EMAIL)}>
                {SUPPORT_EMAIL}
              </a>
              <dl className="support-contact-list">
                {business && (
                  <div>
                    <dt>Business, partnerships and press</dt>
                    <dd>
                      <a href={business}>{contactText(business)}</a>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>News and announcements</dt>
                  <dd>
                    <a href={SOCIAL.x} target="_blank" rel="noreferrer noopener">
                      @VisionSwapSol on X
                    </a>
                  </dd>
                </div>
              </dl>
              <p className="support-contact-note">
                We never ask for your private key, your wallet's recovery phrase or the signature that opens your account. Leave them out
                of every message.
              </p>
            </aside>
          </div>
        </section>

        <section className="support-main" aria-label="Frequently asked questions">
          <div className="wrap support-layout">
            <aside className="support-aside">
              <p className="eyebrow">Guidance for every step</p>
              <h2>Find your answer.</h2>
              <p>Search across questions and answers, or narrow the list by topic.</p>
              <nav className="support-source-links" aria-label="More VisionSwap information">
                <a href="/faq">Common questions</a>
                <a href="/docs">Read the documentation</a>
                <a href="/terms">Review the terms</a>
              </nav>
            </aside>

            <div className="support-questions">
              <div className="support-tools">
                <div className="support-search">
                  <label htmlFor="support-search">Search support</label>
                  <input
                    id="support-search"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Try “wallet” or “fees”"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <p className="support-category-label" id="support-category-label">Browse topics</p>
                  <div className="support-categories" role="group" aria-labelledby="support-category-label">
                    <button
                      type="button"
                      className="support-category"
                      aria-pressed={category === "all"}
                      onClick={() => setCategory("all")}
                    >
                      All topics
                    </button>
                    {SUPPORT_CATEGORIES.map((item) => (
                      <button
                        type="button"
                        className="support-category"
                        key={item.id}
                        aria-pressed={category === item.id}
                        onClick={() => setCategory(item.id)}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="support-results-meta" aria-live="polite">
                <span>Support library</span>
                <strong>{filteredFaqs.length} {filteredFaqs.length === 1 ? "answer" : "answers"}</strong>
              </div>

              {filteredFaqs.length > 0 ? (
                <div className="support-faq-list">
                  {filteredFaqs.map((faq) => {
                    const isExpanded = expanded === faq.id;
                    const answerId = `support-answer-${faq.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
                    const categoryLabel = SUPPORT_CATEGORIES.find((item) => item.id === faq.category)?.label;
                    return (
                      <article className="support-faq-item" key={faq.id}>
                        <button
                          type="button"
                          className="support-faq-question"
                          aria-expanded={isExpanded}
                          aria-controls={answerId}
                          onClick={() => setExpanded(isExpanded ? null : faq.id)}
                        >
                          <span className="support-faq-question-text">
                            {categoryLabel && <span className="support-faq-category">{categoryLabel}</span>}
                            <strong>{faq.question}</strong>
                          </span>
                          <span className="support-faq-toggle" aria-hidden="true" />
                        </button>
                        {/* always in the page (search engines and readers without scripts get every answer); shown when opened */}
                        <div className="support-faq-answer" id={answerId} hidden={!isExpanded}>
                          <p>{faq.answer}</p>
                          {faq.links && faq.links.length > 0 && (
                            <div className="support-faq-answer-links">
                              {faq.links.map((link) => (
                                <a href={link.href} key={`${link.href}-${link.label}`}>{link.label}</a>
                              ))}
                            </div>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="support-empty" role="status">
                  <h3>No matches yet.</h3>
                  <p>Try another phrase or clear the topic filter to see more answers.</p>
                  <button type="button" onClick={resetFilters}>Clear search and filters</button>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}