import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError } from "zod";
import { radarControlSchema } from "@/lib/radar/contracts";
import { controlRadarRuntime, RadarProvisionError } from "@/lib/radar/provisioning";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PUT") {
    res.setHeader("Allow", "PUT");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    return res.status(200).json(controlRadarRuntime(radarControlSchema.parse(req.body)));
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Invalid Radar runtime control", issues: error.issues });
    }
    if (error instanceof RadarProvisionError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[radar] Runtime control failed:", message);
    return res.status(503).json({ error: message });
  }
}
