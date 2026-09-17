import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError } from "zod";
import { radarProvisionSchema } from "@/lib/radar/contracts";
import { provisionRadarCampaign, RadarProvisionError, RadarRuntimePausedError } from "@/lib/radar/provisioning";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const input = radarProvisionSchema.parse(req.body);
    const result = provisionRadarCampaign(input);
    return res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Invalid Radar campaign manifest", issues: error.issues });
    }
    if (error instanceof RadarProvisionError) {
      return res.status(error.statusCode).json({
        error: error.message,
        // 423: nothing was written. Sending and reads stay off and the parked
        // runs stay parked until the incident is acknowledged.
        ...(error instanceof RadarRuntimePausedError ? { pause: error.pause } : {}),
      });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[radar] Campaign provisioning failed:", message);
    return res.status(503).json({ error: message });
  }
}
