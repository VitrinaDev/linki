import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError } from "zod";
import { radarAccountSchema } from "@/lib/radar/contracts";
import { RadarProvisionError } from "@/lib/radar/provisioning";
import { upsertRadarAccount } from "@/lib/radar/runtime";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const account = upsertRadarAccount(radarAccountSchema.parse(req.body)) as { id: string };
    // Metadata changes are rare and must take effect on the very next task.
    // In particular, changing the email clears stored cookies; keeping an old
    // in-memory browser context would otherwise continue as the previous user.
    const { closeSession } = await import("@/lib/linkedin/session");
    await closeSession(account.id);
    return res.status(200).json(account);
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Invalid LinkedIn account", issues: error.issues });
    }
    if (error instanceof RadarProvisionError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[radar] Account setup failed:", message);
    return res.status(503).json({ error: message });
  }
}
