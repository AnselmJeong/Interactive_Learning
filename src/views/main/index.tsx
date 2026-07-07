import React from "react";
import { createRoot } from "react-dom/client";
import { Electroview } from "electrobun/view";
import type { AppRPC } from "../../shared/rpc-types";
import { App } from "./App";

const rpc = Electroview.defineRPC<AppRPC>({
  maxRequestTime: Infinity,
  handlers: {
    requests: {},
    messages: {
      "sources.ingestionProgress": (payload) => window.dispatchEvent(new CustomEvent("ingestion-progress", { detail: payload })),
      "materials.generationProgress": (payload) => window.dispatchEvent(new CustomEvent("generation-progress", { detail: payload })),
      "tutor.turnStarted": (payload) => window.dispatchEvent(new CustomEvent("tutor-started", { detail: payload })),
      "tutor.turnCompleted": (payload) => window.dispatchEvent(new CustomEvent("tutor-completed", { detail: payload })),
      "tutor.turnError": (payload) => window.dispatchEvent(new CustomEvent("tutor-error", { detail: payload })),
      "tutor.prefetchStatus": (payload) => window.dispatchEvent(new CustomEvent("tutor-prefetch-status", { detail: payload })),
      "sessions.batchMessagesStatus": (payload) => window.dispatchEvent(new CustomEvent("session-batch-status", { detail: payload })),
      "app.openAbout": () => window.dispatchEvent(new CustomEvent("app-open-about")),
    },
  },
});

const electroview = new Electroview({ rpc });

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App request={(method, params) => electroview.rpc!.request(method as never, params as never)} />
  </React.StrictMode>
);
