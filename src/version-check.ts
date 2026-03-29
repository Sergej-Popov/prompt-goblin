export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
}

/**
 * Parses a semver string like "1.2.3" or "v1.2.3" into a numeric tuple.
 * Returns null if unparseable.
 */
export function parseSemver(version: string): [number, number, number] | null {
  const cleaned = version.replace(/^v/, "").trim()
  const parts = cleaned.split(".")
  if (parts.length < 3) return null
  const [major, minor, patch] = parts.map(Number)
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null
  }
  return [major, minor, patch]
}

/**
 * Returns true if `candidate` is strictly newer than `current`.
 */
export function isNewerVersion(current: string, candidate: string): boolean {
  const cur = parseSemver(current)
  const cand = parseSemver(candidate)
  if (!cur || !cand) return false
  if (cand[0] !== cur[0]) return cand[0] > cur[0]
  if (cand[1] !== cur[1]) return cand[1] > cur[1]
  return cand[2] > cur[2]
}

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/Sergej-Popov/prompt-goblin/releases/latest"

export interface FetchLatestRelease {
  (url: string): Promise<{ tagName: string; htmlUrl: string }>
}

async function defaultFetchLatestRelease(url: string): Promise<{ tagName: string; htmlUrl: string }> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!response.ok) {
    throw new Error(`GitHub releases fetch failed: HTTP ${response.status}`)
  }
  const data = await response.json() as { tag_name?: string; html_url?: string }
  if (typeof data.tag_name !== "string" || typeof data.html_url !== "string") {
    throw new Error("Unexpected GitHub releases response shape")
  }
  return { tagName: data.tag_name, htmlUrl: data.html_url }
}

export async function checkLatestVersion(
  currentVersion: string,
  fetchRelease: FetchLatestRelease = defaultFetchLatestRelease
): Promise<VersionCheckResult> {
  const { tagName, htmlUrl } = await fetchRelease(GITHUB_RELEASES_URL)
  const latestVersion = tagName.replace(/^v/, "")
  return {
    currentVersion,
    latestVersion,
    updateAvailable: isNewerVersion(currentVersion, latestVersion),
    releaseUrl: htmlUrl,
  }
}
