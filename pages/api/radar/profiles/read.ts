import type { NextApiRequest, NextApiResponse } from "next";
import { ZodError } from "zod";
import { ensureGlobalRunnerStarted } from "@/lib/linkedin/runner";
import { radarProfileReadSchema } from "@/lib/radar/contracts";
import { requestProfileRead } from "@/lib/radar/profile-reads";

/**
 * Queue one profile read. Authenticated by the existing `x-internal-secret`
 * gate in proxy.ts — no new exception. The job is durable; the answer says only
 * that it was accepted, never what was read. The result travels back over the
 * signed Radar callback.
 *
 * `radar_persona_id` is opaque to Linki: it is echoed in the callback and used
 * for nothing else. No target, run or track is created here or later.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const input = radarProfileReadSchema.parse(req.body);
    const result = requestProfileRead(input);

    switch (result.outcome) {
      case "disabled":
        return res.status(423).json({ error: "Profile reads are disabled on this runtime" });
      case "duplicate":
        return res.status(409).json({ jobId: result.jobId, duplicated: true });
      case "capped":
        res.setHeader("Retry-After", String(result.retryAfter));
        return res.status(429).json({ error: "Daily read cap reached", retryAfter: result.retryAfter });
      case "queued":
        if (process.env.LINKI_DISABLE_RUNNER !== "true") ensureGlobalRunnerStarted();
        return res.status(201).json({
          jobId: result.jobId,
          status: result.status,
          scheduledAt: result.scheduledAt,
        });
    }
  } catch (error) {
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Invalid Radar profile read request", issues: error.issues });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[radar] Profile read request failed:", message);
    return res.status(503).json({ error: message });
  }
}
