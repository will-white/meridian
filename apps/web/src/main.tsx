import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App.js";
import { ApiError } from "./lib/api.js";
import { AUTH_KEY } from "./lib/auth.js";
import { isSignedOutError } from "./lib/security.js";
import "./styles.css";

/**
 * A request answered "not signed in" (the session expired, was signed out from another
 * device, or ended after wrong codes): ask the server who we are again, so the app shows
 * the sign-in screen and not an error on whatever page was open.
 */
const onRequestError = (error: unknown) => {
  if (isSignedOutError(error)) void queryClient.invalidateQueries({ queryKey: AUTH_KEY });
};

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onRequestError }),
  mutationCache: new MutationCache({ onError: onRequestError }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
