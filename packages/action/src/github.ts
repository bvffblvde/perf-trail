import { getOctokit } from "@actions/github";

export type Repo = { owner: string; repo: string };

export type CommitInfo = { message: string; date: string };

export type CommitFilesResult = "ok" | "conflict";

export interface GitHubApi {
  getCommit(sha: string): Promise<CommitInfo>;
  getBranchHead(branch: string): Promise<string | null>;
  readFile(ref: string, path: string): Promise<string | null>;
  commitFiles(options: {
    branch: string;
    parent: string | null;
    files: Record<string, string>;
    message: string;
  }): Promise<CommitFilesResult>;
  findPullRequest(sha: string): Promise<number | undefined>;
  findPreviewDeployment(
    sha: string,
    environmentPrefix: string,
  ): Promise<{ url: string; environment: string } | undefined>;
  upsertComment(issue: number, heading: string, body: string): Promise<"created" | "updated">;
}

export function createGitHubApi(token: string, repo: Repo): GitHubApi {
  const { rest } = getOctokit(token);
  return {
    async getCommit(sha) {
      const { data } = await rest.repos.getCommit({ ...repo, ref: sha });
      const date = data.commit.committer?.date ?? data.commit.author?.date;
      if (!date) throw new Error(`Commit ${sha} has no date`);
      return { message: data.commit.message, date };
    },
    async getBranchHead(branch) {
      try {
        const { data } = await rest.git.getRef({ ...repo, ref: `heads/${branch}` });
        return data.object.sha;
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },
    async readFile(ref, path) {
      try {
        const { data } = await rest.repos.getContent({
          ...repo,
          path,
          ref,
          mediaType: { format: "raw" },
        });
        return data as unknown as string;
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },
    async findPullRequest(sha) {
      const { data } = await rest.repos.listPullRequestsAssociatedWithCommit({
        ...repo,
        commit_sha: sha,
      });
      const open = data.filter((pr) => pr.state === "open");
      return (open[0] ?? data[0])?.number;
    },
    async findPreviewDeployment(sha, environmentPrefix) {
      const { data } = await rest.repos.listDeployments({ ...repo, sha, per_page: 20 });
      for (const deployment of data) {
        if (!deployment.environment.startsWith(environmentPrefix)) continue;
        const { data: statuses } = await rest.repos.listDeploymentStatuses({
          ...repo,
          deployment_id: deployment.id,
          per_page: 1,
        });
        const status = statuses[0];
        const url = status?.environment_url || status?.target_url;
        if (status?.state === "success" && url) return { url, environment: deployment.environment };
      }
      return undefined;
    },
    async upsertComment(issue, heading, body) {
      const { data } = await rest.issues.listComments({
        ...repo,
        issue_number: issue,
        per_page: 100,
      });
      const mine = data.find(
        (comment) => comment.user?.type === "Bot" && comment.body?.startsWith(heading),
      );
      if (mine) {
        await rest.issues.updateComment({ ...repo, comment_id: mine.id, body });
        return "updated";
      }
      await rest.issues.createComment({ ...repo, issue_number: issue, body });
      return "created";
    },
    async commitFiles({ branch, parent, files, message }) {
      const baseTree = parent
        ? (await rest.git.getCommit({ ...repo, commit_sha: parent })).data.tree.sha
        : undefined;
      const { data: tree } = await rest.git.createTree({
        ...repo,
        ...(baseTree ? { base_tree: baseTree } : {}),
        tree: Object.entries(files).map(([path, content]) => ({
          path,
          mode: "100644" as const,
          type: "blob" as const,
          content,
        })),
      });
      const { data: commit } = await rest.git.createCommit({
        ...repo,
        message,
        tree: tree.sha,
        parents: parent ? [parent] : [],
      });
      try {
        if (parent) {
          await rest.git.updateRef({
            ...repo,
            ref: `heads/${branch}`,
            sha: commit.sha,
            force: false,
          });
        } else {
          await rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: commit.sha });
        }
        return "ok";
      } catch (error) {
        if (status(error) === 422 || status(error) === 409) return "conflict";
        throw error;
      }
    },
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}
