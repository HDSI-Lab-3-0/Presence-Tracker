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

crons.cron(
  "cleanupOldLogs",
  "0 0 * * *",
  internal.devices.cleanupOldLogs,
  {},
);

export default crons;
