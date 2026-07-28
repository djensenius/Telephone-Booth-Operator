import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { purgeLegacyDebugConnectionTokens } from "./lib/debug-client.js";
import "./styles/theme.css";

purgeLegacyDebugConnectionTokens();

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
