import { PLANNER_DISCLAIMER, type RetirementCard } from "@meridian/shared";
import { shortDate } from "./format.js";
import { successTone, type SuccessTone } from "./retirement.js";
import { compactMoney, countText, percentText } from "./retirementFormat.js";

/**
 * The dashboard card's texts (strategies-outputs-web §5.8, UI-5) for `DashboardView.retirement`
 * (inputs-and-data §4.9). The design puts `successTone`, `successText` and `retirementStaleText` in
 * components/dashboard/dashboard.ts; that file is outside this step, so they live here and the card
 * component of step 30 imports them.
 */

/** The success rate as the card's hero: whole percent, truncated so it never shows more than measured: 9420 → "94%". */
export function successText(successBp: number): string {
  return percentText(successBp, 0);
}

/** Why a finished run may no longer describe the plan; null when it is current or was not evaluated. */
export function retirementStaleText(stale: { inputsChanged: boolean; engineChanged: boolean } | null | undefined): string | null {
  if (!stale) return null;
  if (stale.inputsChanged && stale.engineChanged) return "Your accounts or profile changed since this run, and the engine or its data was updated";
  if (stale.inputsChanged) return "Your accounts or profile changed since this run";
  if (stale.engineChanged) return "The engine or its data was updated";
  return null;
}

export interface CardLink {
  to: string;
  label: string;
}

/** What the card shows, by state (§5.8). `null`: nothing at all (a viewer before any profile exists). */
export type RetirementCardView =
  | { kind: "setup"; title: string; link: CardLink }
  | { kind: "no_run"; title: string; link: CardLink; issuesText?: string }
  | { kind: "running"; title: string; progressBp: number; previous?: ReadyFigures }
  | { kind: "failed"; title: string; link: CardLink }
  | ({ kind: "ready" } & ReadyFigures);

export interface ReadyFigures {
  hero: string;
  tone: SuccessTone;
  /** "9,402 of 10,000 simulated futures funded the plan". */
  countText: string;
  /** "Median ending wealth $1.2M, 10th percentile $0 (today's dollars)". */
  wealthText: string;
  /** "Base plan · run 11/08/26". */
  runText: string;
  staleText?: string;
  link: CardLink;
  /** The card's title attribute. */
  title: string;
}

function readyFigures(card: RetirementCard): ReadyFigures | undefined {
  const run = card.run;
  if (run === null) return undefined;
  const figures: ReadyFigures = {
    hero: successText(run.successBp),
    tone: successTone(run.successBp),
    countText: `${countText(run.successPaths)} of ${countText(run.paths)} simulated futures funded the plan`,
    wealthText: `Median ending wealth ${compactMoney(run.medianEndingRealCents)}, 10th percentile ${compactMoney(run.p10EndingRealCents)} (today's dollars)`,
    runText: `${card.scenarioName} · run ${shortDate(run.finishedAt)}`,
    link: { to: `/retirement?scenario=${encodeURIComponent(card.scenarioId)}`, label: "Open retirement plan" },
    title: PLANNER_DISCLAIMER,
  };
  const stale = retirementStaleText(run.stale);
  if (stale !== null) figures.staleText = stale;
  return figures;
}

/**
 * The card for each state of §5.8: no profile → "Plan your retirement" for the owner and nothing
 * for the viewer; `no_run` → "No simulation yet" (with "N things to fix before a run"); `running`
 * → "Simulating: 62%" with the previous run's figures underneath when there is one; `failed` →
 * "The last run failed"; `ready` → the hero rate and its lines.
 */
export function retirementCardView(card: RetirementCard | null, isViewer: boolean): RetirementCardView | null {
  if (card === null) return isViewer ? null : { kind: "setup", title: "Plan your retirement", link: { to: "/retirement/profile", label: "Set up your retirement profile" } };
  const scenarioLink = { to: `/retirement/scenarios/${encodeURIComponent(card.scenarioId)}`, label: card.scenarioName };
  switch (card.state) {
    case "no_run": {
      const view: RetirementCardView = { kind: "no_run", title: "No simulation yet", link: scenarioLink };
      if (card.issues > 0) view.issuesText = `${countText(card.issues)} ${card.issues === 1 ? "thing" : "things"} to fix before a run`;
      return view;
    }
    case "running": {
      const progressBp = Math.max(0, Math.min(10_000, card.active?.progressBp ?? 0));
      const view: RetirementCardView = { kind: "running", title: `Simulating: ${percentText(progressBp, 0)}`, progressBp };
      const previous = readyFigures(card);
      if (previous !== undefined) view.previous = previous;
      return view;
    }
    case "failed":
      return { kind: "failed", title: "The last run failed", link: { to: "/retirement/history", label: "History" } };
    case "ready": {
      const figures = readyFigures(card);
      // `ready` always carries a run (inputs §4.9); without one the card says what it can.
      return figures === undefined ? { kind: "no_run", title: "No simulation yet", link: scenarioLink } : { kind: "ready", ...figures };
    }
  }
}
