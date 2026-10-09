import {
  BaseMessageSignerWalletAdapter,
  WalletReadyState,
  WalletNotConnectedError,
  type WalletName,
  type TransactionOrVersionedTransaction,
} from "@solana/wallet-adapter-base";
import { Keypair, VersionedTransaction, type PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

/**
 * A throwaway wallet for development against a local test validator. It is
 * only ever bundled into dev builds (see wallet.tsx) and never on mainnet.
 */
export const DevWalletName = "Test wallet (local only)" as WalletName<"Test wallet (local only)">;
const KEY = "vs:devwallet";
const ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#160a24"/><circle cx="24" cy="30" r="9" fill="#fff"/><circle cx="40" cy="30" r="9" fill="#fff"/><rect x="12" y="32" width="40" height="10" rx="3" fill="#8804fe"/></svg>',
  );

export class DevWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = DevWalletName;
  url = "https://localhost";
  icon = ICON;
  readonly supportedTransactionVersions = new Set(["legacy" as const, 0 as const]);
  private kp: Keypair | null = null;

  get publicKey(): PublicKey | null {
    return this.kp?.publicKey ?? null;
  }
  get connecting() {
    return false;
  }
  get readyState() {
    return WalletReadyState.Installed;
  }

  async connect(): Promise<void> {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* no storage */
    }
    this.kp = saved ? Keypair.fromSecretKey(bs58.decode(saved)) : Keypair.generate();
    try {
      localStorage.setItem(KEY, bs58.encode(this.kp.secretKey));
    } catch {
      /* ignore */
    }
    this.emit("connect", this.kp.publicKey);
  }

  async disconnect(): Promise<void> {
    this.kp = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(tx: T): Promise<T> {
    if (!this.kp) throw new WalletNotConnectedError();
    if (tx instanceof VersionedTransaction) tx.sign([this.kp]);
    else tx.partialSign(this.kp);
    return tx;
  }

  async signAllTransactions<T extends TransactionOrVersionedTransaction<this["supportedTransactionVersions"]>>(txs: T[]): Promise<T[]> {
    for (const t of txs) await this.signTransaction(t);
    return txs;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.kp) throw new WalletNotConnectedError();
    return ed25519.sign(message, this.kp.secretKey.slice(0, 32));
  }
}
