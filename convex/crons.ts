import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "updatePresenceNotifications",
  { minutes: 1 },
  internal.notifications.updatePresenceNotifications,
  {},
);

crons.interval(
  "cleanupExpiredDevices",
  { minutes: 1 },
  internal.devices.cleanupExpiredGracePeriodsInternal,
  {},
);

crons.interval(
  "expirePendingAttendanceVerifications",
  { minutes: 1 },
  internal.devices.expirePendingAttendanceVerifications,
  {},
);

crons.cron(
  "cleanupOldLogs",
  "0 0 * * *",
  internal.devices.cleanupOldLogs,
  {},
);

// Pacific midnight is 07:00 UTC (PDT) or 08:00 UTC (PST); run shortly after both so one hits each night.
crons.cron(
  "pacificMidnightCheckout-utc7",
  "5 7 * * *",
  internal.devices.pacificMidnightCheckoutIfDue,
  {},
);

crons.cron(
  "pacificMidnightCheckout-utc8",
  "5 8 * * *",
  internal.devices.pacificMidnightCheckoutIfDue,
  {},
);

export default crons;
