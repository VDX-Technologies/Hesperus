// Extension points called after alert transitions. The AI layer will register here (to fill
// alerts.ai with a summary or probable cause); nothing is registered by default.
import type { Db } from "./db";

export interface AlertTransition {
  kind: "opened" | "resolved";
  alertId: string;
  tenantId: string;
  objectId: string;
  ruleKey: string;
  severity: string;
  value: number;
  ts: Date;
}

export type AlertHook = (t: AlertTransition, db: Db) => Promise<void> | void;

const hooks = new Set<AlertHook>();

/** Registers a hook; returns the function that removes it. */
export function onAlert(h: AlertHook): () => void {
  hooks.add(h);
  return () => void hooks.delete(h);
}

/** Runs every hook; a failing hook is logged and never breaks ingestion. */
export async function runAlertHooks(ts: AlertTransition[], db: Db): Promise<void> {
  for (const t of ts) for (const h of hooks) {
    try {
      await h(t, db);
    } catch (e) {
      console.error("alert hook failed", e);
    }
  }
}
