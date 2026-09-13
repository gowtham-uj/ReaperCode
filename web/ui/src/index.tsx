import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import { App } from "./App.jsx";
import { applyTheme, readTheme } from "./theme.js";
import "./styles.css";

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
