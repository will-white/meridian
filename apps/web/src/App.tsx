import { useQuery } from "@tanstack/react-query";

export function App() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: async () => {
      const res = await fetch("/api/health");
      if (!res.ok) throw new Error(`API ${res.status}`);
      return (await res.json()) as { ok: true };
    },
  });

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>Meridian</h1>
      <p>API: {health.isLoading ? "checking…" : health.isError ? "unreachable" : "ok"}</p>
    </main>
  );
}
