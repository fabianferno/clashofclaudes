import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/lilita-one/400.css";
import App from "./App";
import MiniApp from "./MiniApp";
import { armSplash } from "./splash";

// The mini village's window loads this page with ?view=mini: the village alone, nothing else started.
const mini = new URLSearchParams(window.location.search).get("view") === "mini";

if (mini) {
  document.getElementById("splash")?.remove(); // the main window's; the mini village just appears
} else {
  armSplash();
  if (import.meta.env.DEV) {
    void import("./driver");
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {mini ? <MiniApp /> : <App />}
  </React.StrictMode>,
);
