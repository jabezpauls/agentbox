import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./theme/tokens.css";
import "./app.css";
import "./styles/shell.css";
import "./styles/surfaces.css";
import "./styles/files.css";
import "./styles/system.css";
import "./styles/settings.css";
import "./styles/apps.css";
import "./styles/usage.css";
import { App } from "./App.tsx";
import { installSessionGuard } from "./api/session-guard.ts";

// Before anything fetches: a session that ended sends the page to sign in.
installSessionGuard();

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
