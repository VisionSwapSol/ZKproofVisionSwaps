import { createContext, useContext } from "react";

/**
 * Whether the tab a form sits in is the one on screen. The Shield, Send, Buy and Sell forms stay
 * mounted when another tab is picked (so what was typed is still there on coming back); while
 * hidden they pause their own polling: quotes, live prices, the QR code watch, fee wallet balances.
 */
export const TabActive = createContext(true);

export const useTabActive = () => useContext(TabActive);
