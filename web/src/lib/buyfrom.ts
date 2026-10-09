import { useEffect, useState } from "react";

/**
 * "Buy a token" on Vision wallets (a row, or the wallets ticked in the Wallets tab): which wallets
 * the Buy form spends from instead of the private balance (empty: the private balance). Shared by
 * the Wallets tab, the Buy form and the page, which switches to the Buy tab.
 */
let current: number[] = [];
const subs = new Set<(i: number[]) => void>();

export function buyFromVision(i: number[]) {
  current = [...i];
  subs.forEach((f) => f(current));
}

export function onBuyFrom(f: (i: number[]) => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export function useBuyFrom(): number[] {
  const [i, setI] = useState(current);
  useEffect(() => onBuyFrom(setI), []);
  return i;
}

/**
 * "Sell" on a Vision wallet's holding: the Sell form picks it ("<index>:<mint>") and the page
 * switches to the Sell tab. Kept until the form reads it, for a Sell tab not opened yet.
 */
let sellPick = "";
const sellSubs = new Set<(pick: string) => void>();

export function sellFromVision(index: number, mint: string) {
  sellPick = `${index}:${mint}`;
  sellSubs.forEach((f) => f(sellPick));
}

/** The holding last picked with "Sell" ("" for none). */
export const sellPicked = () => sellPick;

export function onSellFrom(f: (pick: string) => void): () => void {
  sellSubs.add(f);
  return () => {
    sellSubs.delete(f);
  };
}
