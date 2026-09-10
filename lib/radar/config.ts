import { getDb } from "@/lib/db";
import { DEFAULT_RADAR_LIST_ID } from "./contracts";

export interface RadarConfig {
  listId: string;
  workflowId: string;
  accountId: string;
}

export function getRadarConfig(): RadarConfig {
  const config = getOptionalRadarConfig();
  if (!config) {
    throw new Error("RADAR_WORKFLOW_ID and RADAR_LINKEDIN_ACCOUNT_ID must be configured");
  }
  return config;
}

export function getOptionalRadarConfig(): RadarConfig | null {
  try {
    const managed = getDb().prepare(
      "SELECT list_id, workflow_id, account_id FROM radar_runtime_config WHERE id = 1",
    ).get() as { list_id: string; workflow_id: string; account_id: string } | undefined;
    if (managed) {
      return { listId: managed.list_id, workflowId: managed.workflow_id, accountId: managed.account_id };
    }
  } catch {
    // Backward-compatible fallback for databases created before provisioning.
  }
  const workflowId = process.env.RADAR_WORKFLOW_ID?.trim();
  const accountId = process.env.RADAR_LINKEDIN_ACCOUNT_ID?.trim();
  if (!workflowId || !accountId) return null;
  return { listId: process.env.RADAR_LIST_ID?.trim() || DEFAULT_RADAR_LIST_ID, workflowId, accountId };
}

export function radarRequiresProxy(): boolean {
  return process.env.LINKI_REQUIRE_PROXY === "true" || getOptionalRadarConfig() !== null;
}

export function getRadarCallbackConfig(): { url: string; secret: string } | null {
  const url = process.env.RADAR_CALLBACK_URL?.trim();
  const secret = process.env.RADAR_CALLBACK_SECRET?.trim();
  return url && secret ? { url, secret } : null;
}
