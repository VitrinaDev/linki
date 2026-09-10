import type { NextApiRequest, NextApiResponse } from "next";
import { radarPauseSchema } from "@/lib/radar/contracts";
import { pauseRadarContact } from "@/lib/radar/enrollment";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "PATCH") {
    res.setHeader("Allow", "PATCH");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const parsed = radarPauseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Body must be { status: 'PAUSED' }" });

  const radarLeadId = Array.isArray(req.query.radarLeadId)
    ? req.query.radarLeadId[0]
    : req.query.radarLeadId;
  if (!radarLeadId) return res.status(400).json({ error: "radarLeadId is required" });

  if (!pauseRadarContact(radarLeadId)) return res.status(404).json({ error: "Radar contact not found" });
  return res.status(200).json({ radarLeadId, status: "PAUSED" });
}
