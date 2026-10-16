import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { WalletProvider, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useStandardWalletAdapters } from "@solana/wallet-standard-wallet-adapter-react";
import type { Adapter, WalletError } from "@solana/wallet-adapter-base";
import { engine, type State, type WalletLike } from "./engine";
import { DevWalletAdapter } from "./devwallet";
import { autoConnectAllowed } from "./terms";
import { createMobileWalletAdapter, inferredCluster, isMobileWeb, SolanaMobileWalletAdapterWalletName } from "./mwa";

/**
 * Wallets are discovered through the Wallet Standard (Phantom, Solflare,
 * Backpack, Jupiter, OKX, Coinbase and others register themselves), plus the
 * Mobile Wallet Adapter on Android. The provider would add that one itself,
 * but without the app's name, so wallet apps showed "<no name>": we make it
 * (mwa.ts) where and as the provider would, and the provider uses ours.
 */
export function Wallets({ children }: { children: ReactNode }) {
  // the throwaway test wallet exists only in development builds
  const own = useMemo<Adapter[]>(
    () => (import.meta.env.DEV || import.meta.env.VITE_DEV_WALLET === "1" ? [new DevWalletAdapter()] : []),
    [],
  );
  // the list the provider looks at to decide whether this is a phone browser, so ours appears exactly when its own would
  const seen = useStandardWalletAdapters(own);
  const mobile = isMobileWeb(seen, globalThis.navigator?.userAgent ?? null);
  const { connection } = useConnection();
  const cluster = inferredCluster(connection?.rpcEndpoint);
  const mwa = useMemo(() => (mobile ? createMobileWalletAdapter(location.origin, cluster) : null), [mobile, cluster]);
  const wallets = useMemo(() => (mwa ? [mwa, ...own] : own), [mwa, own]);
  return (
    <WalletProvider
      wallets={wallets}
      // a wallet chosen on an earlier visit reconnects by itself only once the Terms in force are accepted on this device
      autoConnect={autoConnectAllowed}
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

/** The name the Mobile Wallet Adapter goes by (wallet apps on an Android phone; made in mwa.ts). */
export const MWA_NAME: string = SolanaMobileWalletAdapterWalletName;

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
