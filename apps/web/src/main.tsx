import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { AppError, ErrorBoundary } from "./components/ErrorBoundary.js";
import { createQueryClient } from "./lib/queryClient.js";
import { startUpdateWatch } from "./lib/swUpdate.js";
import "./styles.css";

const queryClient = createQueryClient();

// The service worker is built for production only (vite-plugin-pwa); the page registers it and
// offers new builds (lib/swUpdate.ts).
if (import.meta.env.PROD) startUpdateWatch();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={(error) => <AppError error={error} />}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
