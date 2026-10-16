import { Fragment, type ReactNode } from "react";
import { clauseNo, type TermsDoc } from "../legal/terms-doc";

/** Text with its [label](href) links. `newTab`: links open in a new tab (inside the Terms window, so nothing navigates away). */
export function Inline({ text, newTab = false }: { text: string; newTab?: boolean }) {
  const parts: ReactNode[] = [];
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) parts.push(text.slice(at, m.index));
    const href = m[2];
    const outside = /^https?:/.test(href) || href.startsWith("mailto:");
    parts.push(
      <a key={m.index} href={href} {...(outside || newTab ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
        {m[1]}
      </a>,
    );
    at = m.index! + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/**
 * The numbered sections of the Terms, from the one source (legal/terms-doc.ts). On the Terms page
 * the headings are h2 with an id each (/terms#risks); inside the Terms window they are h3.
 */
export function TermsSections({ doc, inWindow = false }: { doc: TermsDoc; inWindow?: boolean }) {
  const H = inWindow ? "h3" : "h2";
  return (
    <>
      {doc.sections.map((sec) => (
        <Fragment key={sec.n}>
          <H id={inWindow ? undefined : sec.id}>
            {sec.n}. {sec.title}
          </H>
          {sec.blocks.map((b, bi) =>
            b.k === "p" ? (
              <p key={bi}>
                <Inline text={b.text} newTab={inWindow} />
              </p>
            ) : b.k === "list" ? (
              <ul key={bi}>
                {b.items.map((it) => (
                  <li key={it}>
                    <Inline text={it} newTab={inWindow} />
                  </li>
                ))}
              </ul>
            ) : b.k === "risks" ? (
              <ul key={bi}>
                {b.items.map((it) => (
                  <li key={it.t}>
                    <strong>{it.t}.</strong> <Inline text={it.text} newTab={inWindow} />
                  </li>
                ))}
              </ul>
            ) : (
              <Fragment key={bi}>
                {b.items.map((c, i) => (
                  <p className="clause" key={c.t}>
                    <b>
                      {clauseNo(sec.n, i)} {c.t}.
                    </b>{" "}
                    <Inline text={c.text} newTab={inWindow} />
                  </p>
                ))}
              </Fragment>
            ),
          )}
        </Fragment>
      ))}
    </>
  );
}
