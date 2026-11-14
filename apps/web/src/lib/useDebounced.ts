import { useEffect, useState } from "react";

/** `value`, once it has stayed the same for `ms` (a search box sends one request per pause). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
