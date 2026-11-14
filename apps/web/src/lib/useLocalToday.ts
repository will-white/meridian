import { useEffect, useState } from "react";
import { localToday } from "./plan.js";

/** Milliseconds from `now` to one second past the next local midnight (the second absorbs timer slack). */
export function msUntilNextLocalDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1, 0);
  return next.getTime() - now.getTime();
}

/**
 * The browser's local date (the `today` the PWA sends), kept current while a page stays open:
 * re-read at local midnight and whenever the page becomes visible or gains focus (a laptop that
 * slept past midnight fires no timer on time). A page keyed on it refetches under the new date.
 */
export function useLocalToday(): string {
  const [today, setToday] = useState(() => localToday());
  useEffect(() => {
    const refresh = () => setToday(localToday());
    let timer = setTimeout(function tick() {
      refresh();
      timer = setTimeout(tick, msUntilNextLocalDay(new Date()));
    }, msUntilNextLocalDay(new Date()));
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return today;
}
