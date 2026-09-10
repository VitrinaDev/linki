/**
 * Update checker for the Vitrina-owned fork. It never follows the upstream
 * Docker Hub `latest` tag; releases come from our GitHub repository.
 *
 * State is kept in memory (reset on restart, which is fine — it re-checks immediately).
 */

const RELEASE_URL = "https://api.github.com/repos/VitrinaDev/linki/releases/latest";

const POLL_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface UpdateState {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
}

const state: UpdateState = {
  current: process.env.APP_VERSION ?? "dev",
  latest: null,
  updateAvailable: false,
  checkedAt: null,
};

export function getUpdateState(): UpdateState {
  return { ...state };
}

/** Parse `v1.7.4-radar.2` (and plain semver) into a comparable tuple. */
function parseSemver(v: string): [number, number, number, number] | null {
  const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-radar\.(\d+))?$/);
  if (!m) return null;
  return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), parseInt(m[4] ?? "0")];
}

/** Returns true if b is strictly greater than a */
function isNewer(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  if (pb[0] !== pa[0]) return pb[0] > pa[0];
  if (pb[1] !== pa[1]) return pb[1] > pa[1];
  if (pb[2] !== pa[2]) return pb[2] > pa[2];
  return pb[3] > pa[3];
}

async function checkForUpdate() {
  try {
    const res = await fetch(RELEASE_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "vitrina-linki-update-check" },
    });
    if (!res.ok) return;
    const data = await res.json() as { tag_name?: string };
    const latest = data.tag_name?.replace(/^v/, "") ?? null;
    if (!latest || !parseSemver(latest)) return;

    state.latest = latest;
    state.updateAvailable = state.current !== "dev" && isNewer(state.current, latest);
    state.checkedAt = new Date().toISOString();

    if (state.updateAvailable) {
      console.log(`[update-check] New version available: ${latest} (running ${state.current})`);
    }
  } catch {
    // Non-fatal — silently ignore network errors
  }
}

const g = global as typeof global & { __updateCheckScheduled?: boolean };

export function scheduleUpdateCheck() {
  if (g.__updateCheckScheduled) return;
  g.__updateCheckScheduled = true;

  // Run immediately on startup (non-blocking)
  checkForUpdate();

  // Then every 12 hours
  // Do not keep short-lived CLI/test processes alive solely for update checks.
  setInterval(checkForUpdate, POLL_INTERVAL_MS).unref();
}
