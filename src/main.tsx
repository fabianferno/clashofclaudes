import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/lilita-one/400.css";
import App from "./App";
import { armSplash } from "./splash";

armSplash();

if (import.meta.env.DEV) {
  void import("./driver");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
