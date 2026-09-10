export interface RadarConfig {
  listId: string;
  workflowId: string;
  accountId: string;
}

export function getRadarConfig(): RadarConfig {
  const workflowId = process.env.RADAR_WORKFLOW_ID?.trim();
  const accountId = process.env.RADAR_LINKEDIN_ACCOUNT_ID?.trim();
  if (!workflowId || !accountId) {
    throw new Error("RADAR_WORKFLOW_ID and RADAR_LINKEDIN_ACCOUNT_ID must be configured");
  }
  return {
    listId: process.env.RADAR_LIST_ID?.trim() || "radar_vitrina_active_campaign",
    workflowId,
    accountId,
  };
}
