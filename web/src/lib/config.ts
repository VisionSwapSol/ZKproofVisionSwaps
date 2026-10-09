/** Client-side constants. Anything that matters on-chain is read from the program at runtime. */
export const FEES = {
  actionBps: 80,
  actionPct: "0.8%",
  networkSol: "≈0.002 SOL",
};

export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";

/** Official accounts. Opening one is the visitor's choice; the site itself never loads anything from them. */
export const SOCIAL = {
  x: "https://x.com/VisionSwapSol",
};
