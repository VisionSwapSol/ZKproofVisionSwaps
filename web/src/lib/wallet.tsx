import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import type { WalletError } from "@solana/wallet-adapter-base";
import { engine, type State, type WalletLike } from "./engine";
import { DevWalletAdapter } from "./devwallet";

/**
 * Wallets are discovered through the Wallet Standard (Phantom, Solflare,
 * Backpack, Jupiter, OKX, Coinbase and others register themselves), plus the
 * Mobile Wallet Adapter on Android, which the provider adds automatically.
 */
export function Wallets({ children }: { children: ReactNode }) {
  // the throwaway test wallet exists only in development builds
  const wallets = useMemo(
    () => (import.meta.env.DEV || import.meta.env.VITE_DEV_WALLET === "1" ? [new DevWalletAdapter()] : []),
    [],
  );
  return (
    <WalletProvider
      wallets={wallets}
      autoConnect
      localStorageKey="vs:wallet"
      onError={(e: WalletError) => {
        const m = e.message || e.name;
        if (!/reject|cancel|closed|not connected|not ready/i.test(m)) engine.reportError(m);
      }}
    >
      {children}
    </WalletProvider>
  );
}

export function useEngine(): State {
  return useSyncExternalStore(engine.subscribe, engine.get, engine.get);
}

/** The connected wallet, in the shape the engine needs, or null. */
export function useWalletLike(): WalletLike | null {
  const w = useWallet();
  return useMemo(() => {
    if (!w.publicKey || !w.signMessage || !w.signTransaction) return null;
    return { publicKey: w.publicKey, signMessage: w.signMessage, signTransaction: w.signTransaction };
  }, [w.publicKey, w.signMessage, w.signTransaction]);
}

export const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
export const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent);

/** This page, without anything after "?" or a "#" other than a plain tab, so a wallet's link never carries payment details. */
const here = () => location.origin + location.pathname + (/^#\w+$/.test(location.hash) ? location.hash : "");

export function phantomBrowse(url = here()) {
  return `https://phantom.com/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}`;
}

export function solflareBrowse(url = here()) {
  return `https://solflare.com/ul/v1/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(location.origin)}`;
}
