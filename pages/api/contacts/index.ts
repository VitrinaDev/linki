import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError } from "zod";
import { getRadarConfig } from "@/lib/radar/config";
import { radarContactSchema } from "@/lib/radar/contracts";
import { enrollRadarContact, RadarEnrollmentError } from "@/lib/radar/enrollment";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const config = getRadarConfig();
    const input = radarContactSchema.parse(req.body);
    if (input.listId !== config.listId) {
      return res.status(422).json({ error: `listId must be ${config.listId}` });
    }
    const result = enrollRadarContact(input, config);
    return res.status(result.alreadyExists ? 409 : 201).json({ id: result.id, status: result.status });
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Invalid Radar contact payload", issues: error.issues });
    }
    if (error instanceof RadarEnrollmentError) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[radar] Contact enrollment failed:", message);
    return res.status(503).json({ error: message });
  }
}
