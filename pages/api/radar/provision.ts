import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError } from "zod";
import { radarProvisionSchema } from "@/lib/radar/contracts";
import { provisionRadarCampaign, RadarProvisionError } from "@/lib/radar/provisioning";

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
      return res.status(error.statusCode).json({ error: error.message });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[radar] Campaign provisioning failed:", message);
    return res.status(503).json({ error: message });
  }
}
