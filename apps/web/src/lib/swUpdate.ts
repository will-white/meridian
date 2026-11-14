import { useSyncExternalStore } from "react";

/**
 * The service worker and the app's updates (audit b8-web-layout-09). The worker precaches the
 * built shell, so an open app (an installed PWA may stay open for days) keeps running the build
 * it started with. Here the page registers the worker itself and:
 * - checks for a new build when the app comes back into view and every hour;
 * - when a new build is installed beside the running one, offers it (`onUpdateReady`) instead of
 *   reloading on its own, so nothing being typed is lost;
 * - on `apply`, tells the waiting worker to take over and reloads once it controls the page.
 * The first install (nothing controls the page yet) offers nothing: the page is already current.
 */
export interface UpdateWatchOptions {
  onUpdateReady: () => void;
  reload?: () => void;
  doc?: Document;
  checkEveryMs?: number;
  scriptUrl?: string;
}

export interface UpdateWatch {
  /** Settles once the worker is registered (or registration failed). */
  registered: Promise<void>;
  apply: () => void;
  stop: () => void;
}

const HOUR_MS = 60 * 60 * 1000;

export function watchForUpdates(container: ServiceWorkerContainer, options: UpdateWatchOptions): UpdateWatch {
  const reload = options.reload ?? (() => window.location.reload());
  const doc = options.doc ?? document;
  let registration: ServiceWorkerRegistration | null = null;
  let waiting: ServiceWorker | null = null;
  let applying = false;

  const offer = (worker: ServiceWorker) => {
    // A worker installed while nothing controls the page is the first install, not an update.
    if (!container.controller || waiting === worker) return;
    waiting = worker;
    options.onUpdateReady();
  };
  const onControllerChange = () => {
    if (applying) {
      applying = false;
      reload();
    }
  };
  const check = () => {
    void registration?.update().catch(() => undefined);
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") check();
  };

  container.addEventListener("controllerchange", onControllerChange);
  doc.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(check, options.checkEveryMs ?? HOUR_MS);

  const registered = container
    .register(options.scriptUrl ?? "/sw.js", { scope: "/" })
    .then((reg) => {
      registration = reg;
      if (reg.waiting) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed") offer(worker);
        });
      });
    })
    .catch(() => undefined);

  return {
    registered,
    apply() {
      if (waiting && waiting.state === "installed") {
        applying = true;
        waiting.postMessage({ type: "SKIP_WAITING" });
      } else {
        // Already activated (another tab applied it): this page only needs the new files.
        reload();
      }
    },
    stop() {
      clearInterval(timer);
      container.removeEventListener("controllerchange", onControllerChange);
      doc.removeEventListener("visibilitychange", onVisible);
    },
  };
}

// The app's one watch, read by the shell's "new version" notice.
let updateReady = false;
let applyUpdate: () => void = () => undefined;
const listeners = new Set<() => void>();

/** Called once from main.tsx in a production build. */
export function startUpdateWatch(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const watch = watchForUpdates(navigator.serviceWorker, {
    onUpdateReady: () => {
      updateReady = true;
      for (const listener of listeners) listener();
    },
  });
  applyUpdate = watch.apply;
}

export function useAppUpdate(): { ready: boolean; apply: () => void } {
  const ready = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => updateReady,
    () => false,
  );
  return { ready, apply: () => applyUpdate() };
}
