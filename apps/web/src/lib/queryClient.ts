import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { shouldRetry } from "./api.js";
import { AUTH_KEY, watchMember } from "./auth.js";
import { isSignedOutError } from "./security.js";

/**
 * The app's query client. A request answered "not signed in" (the session expired, was signed
 * out from another device, or ended after wrong codes) makes the app ask the server who we are
 * again, so it shows the sign-in screen and not an error on whatever page was open; the member
 * watch then forgets that member's data (audit b8-web-layout-02). A request that got no answer,
 * or a 5xx, is retried; a 4xx is not (b8-web-layout-13).
 */
export function createQueryClient(): QueryClient {
  const onRequestError = (error: unknown) => {
    if (isSignedOutError(error)) void qc.invalidateQueries({ queryKey: AUTH_KEY });
  };
  const qc: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: onRequestError }),
    mutationCache: new MutationCache({ onError: onRequestError }),
    defaultOptions: {
      queries: { retry: shouldRetry, refetchOnWindowFocus: true },
    },
  });
  watchMember(qc);
  return qc;
}
