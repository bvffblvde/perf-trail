import { pageKey } from "./inputs.ts";

export type Target =
  | { kind: "skip"; reason: string }
  | { kind: "measure"; sha: string; deploymentUrl?: string }
  | { kind: "preview"; sha: string; deploymentUrl: string; environment: string }
  | { kind: "pull_request"; sha: string; number: number };

const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "ready_for_review"]);

type PullRequestPayload = {
  action?: string;
  pull_request?: { number?: number; head?: { sha?: string }; draft?: boolean };
};

type DeploymentStatusPayload = {
  deployment_status?: { state?: string; environment_url?: string; target_url?: string };
  deployment?: { sha?: string; environment?: string };
};

export type TargetOptions = {
  environmentPrefix: string;
  previewPrefix?: string | undefined;
};

export function resolveTarget(
  eventName: string,
  payload: unknown,
  sha: string,
  { environmentPrefix, previewPrefix }: TargetOptions,
): Target {
  if (eventName === "push" || eventName === "workflow_dispatch") return { kind: "measure", sha };
  if (eventName === "pull_request" || eventName === "pull_request_target") {
    return pullRequestTarget(payload as PullRequestPayload, previewPrefix);
  }
  if (eventName !== "deployment_status") {
    return {
      kind: "skip",
      reason: `event "${eventName}" is not supported (use deployment_status, push, workflow_dispatch or pull_request)`,
    };
  }
  const { deployment_status: status, deployment } = payload as DeploymentStatusPayload;
  const state = status?.state ?? "unknown";
  if (state !== "success") {
    return { kind: "skip", reason: `deployment status is "${state}", only "success" is measured` };
  }
  if (!deployment?.sha) return { kind: "skip", reason: "deployment payload has no sha" };
  const environment = deployment.environment ?? "";
  const deploymentUrl = status?.environment_url || status?.target_url;
  if (environment.startsWith(environmentPrefix)) {
    return { kind: "measure", sha: deployment.sha, ...(deploymentUrl ? { deploymentUrl } : {}) };
  }
  if (previewPrefix !== undefined && environment.startsWith(previewPrefix)) {
    if (!deploymentUrl) {
      return { kind: "skip", reason: `preview deployment "${environment}" has no URL to audit` };
    }
    return { kind: "preview", sha: deployment.sha, deploymentUrl, environment };
  }
  return {
    kind: "skip",
    reason: `environment "${environment}" does not start with "${environmentPrefix}" (input environment-prefix)${
      previewPrefix === undefined ? "" : ` or "${previewPrefix}" (input preview-environment-prefix)`
    }`,
  };
}

export function auditUrls(
  urls: URL[],
  deploymentUrl: string | undefined,
  useDeploymentUrl: boolean,
): URL[] {
  if (!useDeploymentUrl || !deploymentUrl) return urls;
  const base = new URL(deploymentUrl);
  return urls.map((url) => new URL(pageKey(url), base.origin));
}

function pullRequestTarget(payload: PullRequestPayload, previewPrefix: string | undefined): Target {
  if (previewPrefix === undefined) {
    return { kind: "skip", reason: "pull_request events need preview-comment: true" };
  }
  const action = payload.action ?? "unknown";
  if (!PULL_REQUEST_ACTIONS.has(action)) {
    return {
      kind: "skip",
      reason: `pull request "${action}" is measured by the next deployment_status run instead`,
    };
  }
  const sha = payload.pull_request?.head?.sha;
  const number = payload.pull_request?.number;
  if (!sha || number === undefined)
    return { kind: "skip", reason: "pull request payload has no head sha" };
  if (payload.pull_request?.draft) return { kind: "skip", reason: "pull request is a draft" };
  return { kind: "pull_request", sha, number };
}
