import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuthStatus } from "@meridian/shared";
import { api } from "./api.js";

export const AUTH_KEY = ["auth", "status"] as const;

export function useAuthStatus() {
  return useQuery({ queryKey: AUTH_KEY, queryFn: () => api<AuthStatus>("/auth/status"), staleTime: 30_000, retry: false });
}

export function useAuthMutation<TBody>(path: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TBody) => api<AuthStatus>(path, { method: "POST", body }),
    onSuccess: (status) => {
      qc.setQueryData(AUTH_KEY, status);
      void qc.invalidateQueries();
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/auth/logout", { method: "POST", body: {} }),
    onSuccess: () => {
      qc.clear();
      void qc.invalidateQueries({ queryKey: AUTH_KEY });
    },
  });
}
