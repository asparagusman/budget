import { z } from "zod";

// What the household calls a device — "Grace's phone". Typed on the device
// when it asks to join, and editable afterwards from Admin → Devices.
export const deviceNameSchema = z.string().trim().min(1, "Give this device a name").max(120);

// POST /auth/device-requests — a signed-out browser asking to be let in.
export const deviceRequestSchema = z.object({ deviceName: deviceNameSchema });

/** @typedef {z.infer<typeof deviceRequestSchema>} DeviceRequestInput */

// POST /device-requests/:id/approve — whose device it is: an existing member,
// or someone new to the household (which creates their user). Exactly one.
export const approveDeviceRequestSchema = z.union([
  z.object({ userId: z.uuid() }).strict(),
  z
    .object({ newUserDisplayName: z.string().trim().min(1, "Enter their name").max(120) })
    .strict(),
]);

/** @typedef {z.infer<typeof approveDeviceRequestSchema>} ApproveDeviceRequestInput */

// PATCH /sessions/:id — rename a device.
export const renameDeviceSchema = z.object({ deviceName: deviceNameSchema });

/** @typedef {z.infer<typeof renameDeviceSchema>} RenameDeviceInput */
