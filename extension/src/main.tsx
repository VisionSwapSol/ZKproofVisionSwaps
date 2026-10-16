import "../../web/src/polyfills";
import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../../web/src/styles/tokens.css";
import "../../web/src/styles/base.css";
import "../../web/src/styles/site.css";
import "../../web/src/styles/app.css";
import "./ext.css";
import { Wallets } from "../../web/src/lib/wallet";
import { engine } from "../../web/src/lib/engine";
import { Panel } from "./Panel";

// the development build lets its tests drive the engine, like the website's dev server does
if (import.meta.env.VITE_EXT_DEV === "1") (window as unknown as { __vsEngine?: typeof engine }).__vsEngine = engine;

/** A crash shows a way back instead of a blank panel. Keys live in memory only, so nothing is lost. */
class Crashed extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="crashed" role="alert">
        <h1>This needs a reload.</h1>
        <p>Something here stopped working. Your private balance isn't affected: it lives on Solana, not in this panel.</p>
        <button type="button" className="btn violet" onClick={() => location.reload()}>
          Reload
        </button>
      </main>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Crashed>
      {/* no wallet connects inside an extension; the provider is there for the forms that ask */}
      <Wallets>
        <Panel />
      </Wallets>
    </Crashed>
  </StrictMode>,
);
