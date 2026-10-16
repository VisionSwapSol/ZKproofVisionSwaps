import {
  createDefaultAddressSelector,
  createDefaultAuthorizationResultCache,
  createDefaultWalletNotFoundHandler,
  SolanaMobileWalletAdapter,
  SolanaMobileWalletAdapterWalletName,
} from "@solana-mobile/wallet-adapter-mobile";
import { WalletReadyState } from "@solana/wallet-adapter-base";

/**
 * The Mobile Wallet Adapter (wallet apps on an Android phone), made here instead of by
 * @solana/wallet-adapter-react's WalletProvider. The provider (0.15.40) makes its own with only
 * appIdentity { uri }, so wallet apps showed "<no name>" when asked to connect or sign. Ours is the
 * same adapter with the same defaults, made under the same condition and for the same cluster, plus
 * the app's name and icon. Handing it to the provider in `wallets` makes the provider use it
 * (it looks for an adapter with this name before making one).
 */

/** What wallet apps show for "the app asking". The icon is a path relative to `uri` (the protocol requires that). */
export const APP_NAME = "VisionSwap";
export const APP_ICON = "icon-192.png";

export function appIdentity(origin: string): { name: string; uri: string; icon: string } {
  return { name: APP_NAME, uri: origin, icon: APP_ICON };
}

export type MwaCluster = "mainnet-beta" | "devnet" | "testnet";

/** The provider's getInferredClusterFromEndpoint, line for line: no endpoint means mainnet. */
export function inferredCluster(endpoint: string | undefined): MwaCluster {
  if (!endpoint) return "mainnet-beta";
  if (/devnet/i.test(endpoint)) return "devnet";
  if (/testnet/i.test(endpoint)) return "testnet";
  return "mainnet-beta";
}

/** The provider's WebView test (getEnvironment's isWebView): an app's built-in browser can't hand over to a wallet app. */
function isWebView(userAgent: string): boolean {
  return /(WebView|Version\/.+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+)|; wv\).+(Chrome)\/(\d+)\.(\d+)\.(\d+)\.(\d+))/i.test(userAgent);
}

/**
 * Whether the provider would add the Mobile Wallet Adapter (getEnvironment(...) === MOBILE_WEB):
 * Android, not inside a WebView, and no other wallet already installed (an installed wallet
 * means a desktop extension or a wallet app's own browser, where that wallet is used instead).
 * `adapters` are the ones the provider sees: the Wallet Standard wallets plus the app's own.
 */
export function isMobileWeb(adapters: readonly { name: string; readyState: WalletReadyState }[], userAgent: string | null | undefined): boolean {
  if (adapters.some((a) => a.name !== SolanaMobileWalletAdapterWalletName && a.readyState === WalletReadyState.Installed)) return false;
  return !!userAgent && /android/i.test(userAgent) && !isWebView(userAgent);
}

/** The settings our adapter is made with: the provider's defaults, the provider's cluster, and our name and icon. */
export function mobileAdapterConfig(origin: string, cluster: MwaCluster) {
  return {
    addressSelector: createDefaultAddressSelector(),
    appIdentity: appIdentity(origin),
    authorizationResultCache: createDefaultAuthorizationResultCache(),
    cluster,
    onWalletNotFound: createDefaultWalletNotFoundHandler(),
  };
}

export function createMobileWalletAdapter(origin: string, cluster: MwaCluster): SolanaMobileWalletAdapter {
  return new SolanaMobileWalletAdapter(mobileAdapterConfig(origin, cluster));
}

export { SolanaMobileWalletAdapterWalletName };
