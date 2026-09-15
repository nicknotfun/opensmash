import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
const OgStudio = lazy(() => import("./OgStudio.jsx"));
const NetplayGame = lazy(() => import("./NetplayGame.jsx"));
const gameInvitation = new URLSearchParams(window.location.search).has('game');

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    {gameInvitation ? <Suspense fallback={<main>Loading game…</main>}><NetplayGame/></Suspense> : pathname === "/og-studio" ? (
      <Suspense fallback={<main className="og-studio-loading">Loading Open Graph Studio…</main>}>
        <OgStudio />
      </Suspense>
    ) : <App />}
  </React.StrictMode>,
);
