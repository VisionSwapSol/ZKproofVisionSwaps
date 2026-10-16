import "./polyfills";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/site.css";
import "./styles/app.css";
import "./styles/pages.css";
import { Root } from "./App";

const el = document.getElementById("root")!;
const tree = (
  <StrictMode>
    <Root />
  </StrictMode>
);
// A page written when the site was built (its words already on screen) is taken over in place;
// any other page starts empty. A mismatch is only noted in this browser's console, never sent anywhere.
if (el.firstElementChild) hydrateRoot(el, tree, { onRecoverableError: (e) => console.warn("[hydrate]", e) });
else createRoot(el).render(tree);
