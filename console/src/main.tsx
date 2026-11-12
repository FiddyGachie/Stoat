import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
// Order matters: legacy portal rules first, then the design tokens that override their
// variables, then the layout/component layer that re-skins everything with those tokens.
import "./index.css";
import "./styles/tokens.css";
import "./styles/layout.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
