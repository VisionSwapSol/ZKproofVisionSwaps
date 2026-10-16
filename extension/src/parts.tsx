import type { State } from "../../web/src/lib/engine";
import { EyesTile } from "../../web/src/components/EyesTile";

export type Screen = "home" | "receive" | "send" | "swap" | "wallets" | "activity" | "settings";

export function NetBadge({ st }: { st: State }) {
  const net = st.pool?.network;
  if (!net || net === "mainnet") return null;
  return <p className="net-badge">{net === "localnet" ? "Local test network. Nothing here is real money." : "Devnet. Test funds only."}</p>;
}

export function BusyCard({ st, stepRef }: { st: State; stepRef?: (el: HTMLElement | null) => void }) {
  return (
    <div className="busy" role="status">
      <div className="busy-in" ref={stepRef}>
        <div className="busy-mascot">
          <EyesTile shield={1} compact />
        </div>
        <p className="busy-step">{st.busy!.step}</p>
        {st.busy!.detail && <p className="muted small">{st.busy!.detail}</p>}
        <span className="spinner" aria-hidden="true" />
      </div>
    </div>
  );
}
