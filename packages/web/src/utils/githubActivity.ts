import { summarizeGitHubEvents, type GitHubActivity } from "@tainakanchu/roulette-core";

export { isValidLogin, normalizeLogin } from "./githubLogin";

// GitHub の公開イベント API から直近の活動量を取得する（認証なし・公開情報のみ）

export class GitHubFetchError extends Error {
  constructor(
    message: string,
    readonly kind: "notFound" | "rateLimited" | "network"
  ) {
    super(message);
  }
}

export const fetchGitHubActivity = async (
  login: string,
  now = Date.now()
): Promise<GitHubActivity> => {
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}/events/public?per_page=100`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
  } catch {
    throw new GitHubFetchError("network error", "network");
  }
  if (response.status === 404) throw new GitHubFetchError("not found", "notFound");
  if (response.status === 403 || response.status === 429) {
    throw new GitHubFetchError("rate limited", "rateLimited");
  }
  if (!response.ok) throw new GitHubFetchError(`HTTP ${response.status}`, "network");
  const events = (await response.json()) as unknown;
  return summarizeGitHubEvents(Array.isArray(events) ? events : [], now);
};
