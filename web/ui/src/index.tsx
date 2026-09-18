import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.jsx";
import { applyTheme, readTheme } from "./theme.js";
import "./styles.css";
/*
 * Streamdown's utilities, scoped to `.markdown` by `tailwind.config.js`.
 *
 * After `styles.css` on purpose: Tailwind's rules are scoped and specific, but
 * loading them second keeps the app's own sheet the base layer, so a markdown
 * utility is always an intentional override rather than something fighting the
 * document for precedence.
 */
import "./markdown-tailwind.css";

// `index.html` applies the stored theme inline so the first paint is already
// correct. Re-assert it here for hosts that serve their own shell document.
applyTheme(readTheme());

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
