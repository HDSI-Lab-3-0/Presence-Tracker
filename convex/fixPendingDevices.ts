import { mutation } from "./_generated/server";

// One-time mutation to fix existing devices with undefined/null pendingRegistration
// Run this with: npx convex run fixPendingDevices
export const fixPendingDevices = mutation({
  args: {},
  handler: async (ctx) => {
    const devices = await ctx.db.query("devices").collect();
    let fixedCount = 0;

    for (const device of devices) {
      // Fix devices without firstName (i.e., not yet registered) that have undefined/null pendingRegistration
      if (!device.firstName && !device.lastName && device.pendingRegistration !== false) {
        // These are unregistered devices, should be pending
        if (device.pendingRegistration === undefined || device.pendingRegistration === null) {
          const gracePeriodEnd = device.firstSeen + 300 * 1000; // 5 minutes from firstSeen
          await ctx.db.patch(device._id, {
            pendingRegistration: true,
            gracePeriodEnd: gracePeriodEnd,
          });
          fixedCount++;
          console.log(`Fixed device ${device.macAddress}: set pendingRegistration=true`);
        }
      }
    }

    return { fixedCount };
  },
});
