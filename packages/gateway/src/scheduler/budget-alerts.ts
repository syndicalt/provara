import type { Db } from "@provara/db";
import { runBudgetAlertsCycle } from "../billing/budget-alerts.js";
import { sendEmail } from "../email/index.js";
import { budgetAlertEmail } from "../email/templates.js";

/**
 * Scheduler binding for the daily budget-alerts sweep (#219/T7).
 * Interval: once per day. The underlying cycle is idempotent via
 * `alerted_thresholds`, so hourly / multiple-times-per-day runs would
 * also be safe — daily is the default to keep email volume predictable.
 */

const INTERVAL_MS = 24 * 60 * 60 * 1000;

export function registerBudgetAlertsJob(
  scheduler: {
    schedule: (job: {
      name: string;
      intervalMs: number;
      handler: () => Promise<void>;
      initialDelayMs?: number;
    }) => Promise<void> | void;
  },
  db: Db,
): void {
  scheduler.schedule({
    name: "budget-alerts",
    intervalMs: INTERVAL_MS,
    initialDelayMs: 60_000,
    handler: async () => {
      const stats = await runBudgetAlertsCycle(db, {
        sendEmail: (input) => sendEmail({ to: input.to, subject: input.subject, html: input.html, text: input.text }),
        emailBuilder: (params) => budgetAlertEmail(params),
      });
      if (stats.alertsFired > 0 || stats.periodsReset > 0) {
        console.log(
          `[budget-alerts] checked=${stats.budgetsChecked} fired=${stats.alertsFired} periods_reset=${stats.periodsReset}`,
        );
      }
    },
  });
}
