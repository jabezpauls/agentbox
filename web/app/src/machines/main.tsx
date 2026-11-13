import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "../theme/tokens.css";
import "../app.css";
import "./machines.css";
import { MachinesApp } from "./MachinesApp.tsx";

// The machines origin's UI: the gate serves it (machines.html), with
// `script-src 'self'`, never framed. No session guard of the box's: this
// origin's sign-in is its own.
const root = document.getElementById("machines-root");
if (!root) throw new Error("missing #machines-root");

createRoot(root).render(
  <StrictMode>
    <MachinesApp />
  </StrictMode>,
);
