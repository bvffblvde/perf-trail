import type { GitHubApi } from "../src/github.ts";

export type FakeBranch = { head: string; files: Record<string, string> };

export function fakeGitHub(initial: Record<string, FakeBranch> = {}) {
  const branches = new Map(Object.entries(initial));
  const commits: {
    branch: string;
    parent: string | null;
    files: Record<string, string>;
    message: string;
  }[] = [];
  let conflicts = 0;
  const pulls = new Map<string, number>();
  const comments = new Map<number, string[]>();
  const previews = new Map<string, { url: string; environment: string }>();
  const api: GitHubApi = {
    async getCommit(sha) {
      return {
        message: `feat: change ${sha.slice(0, 7)}\n\nbody`,
        date: "2026-10-01T10:00:00+02:00",
      };
    },
    async getBranchHead(branch) {
      return branches.get(branch)?.head ?? null;
    },
    async readFile(ref, path) {
      const branch = [...branches.values()].find((b) => b.head === ref);
      return branch?.files[path] ?? null;
    },
    async commitFiles(options) {
      commits.push(options);
      if (conflicts > 0) {
        conflicts--;
        return "conflict";
      }
      const current = branches.get(options.branch);
      branches.set(options.branch, {
        head: `commit${commits.length}`,
        files: { ...current?.files, ...options.files },
      });
      return "ok";
    },
    async findPullRequest(sha) {
      return pulls.get(sha);
    },
    async findPreviewDeployment(sha, environmentPrefix) {
      const found = previews.get(sha);
      return found?.environment.startsWith(environmentPrefix) ? found : undefined;
    },
    async upsertComment(issue, heading, body) {
      const list = comments.get(issue) ?? [];
      const index = list.findIndex((c) => c.startsWith(heading));
      if (index >= 0) list[index] = body;
      else list.push(body);
      comments.set(issue, list);
      return index >= 0 ? "updated" : "created";
    },
  };
  return {
    api,
    branches,
    commits,
    pulls,
    comments,
    previews,
    failNextCommits(count: number) {
      conflicts = count;
    },
  };
}
