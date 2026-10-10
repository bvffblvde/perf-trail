import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import * as core from "@actions/core";
import { context } from "@actions/github";
import { badgesFor } from "@perf-trail/badge";
import { measureBundle } from "@perf-trail/bundle";
import {
  type Budgets,
  type Bundle,
  type Entry,
  entrySchema,
  evaluateBudgets,
  firstLine,
  type PageResult,
  parseBudgets,
} from "@perf-trail/core";
import { checkedOutSha, runBuild } from "./build.ts";
import { createGitHubApi, type GitHubApi } from "./github.ts";
import { type Inputs, pageKey, readInputs } from "./inputs.ts";
import { installLighthouse, measurePage } from "./lighthouse.ts";
import { revalidate } from "./revalidate.ts";
import { readLatest, saveEntry } from "./store.ts";
import { PREVIEW_HEADING, summaryMarkdown } from "./summary.ts";
import { auditUrls, resolveTarget, type Target } from "./target.ts";

export async function run(): Promise<void> {
  try {
    const inputs = readInputs((name) => core.getInput(name));
    for (const value of Object.values(inputs.extraHeaders)) core.setSecret(value);
    const resolved = resolveTarget(context.eventName, context.payload, context.sha, {
      environmentPrefix: inputs.environmentPrefix,
      previewPrefix: inputs.previewComment ? inputs.previewEnvironmentPrefix : undefined,
    });
    if (resolved.kind === "skip") return skip(resolved.reason);

    const api = createGitHubApi(inputs.token, context.repo);
    let target: Exclude<Target, { kind: "skip" } | { kind: "pull_request" }>;
    let issue: number | undefined;
    if (resolved.kind === "pull_request") {
      const deployment = await api.findPreviewDeployment(
        resolved.sha,
        inputs.previewEnvironmentPrefix,
      );
      if (!deployment) {
        return skip(
          `no successful preview deployment for ${resolved.sha.slice(0, 7)} yet, the deployment_status run comments when it is ready`,
        );
      }
      issue = resolved.number;
      target = {
        kind: "preview",
        sha: resolved.sha,
        deploymentUrl: deployment.url,
        environment: deployment.environment,
      };
    } else {
      target = resolved;
      if (target.kind === "preview") {
        issue = await api.findPullRequest(target.sha);
        if (issue === undefined) return skip(`no pull request contains ${target.sha.slice(0, 7)}`);
      }
    }
    core.setOutput("skipped", "false");
    const preview = target.kind === "preview";

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const cwd = resolve(workspace, inputs.workingDirectory);
    const budgets = inputs.budgetsPath
      ? await readBudgets(resolve(workspace, inputs.budgetsPath))
      : undefined;
    const bundle = await measureBuild(inputs, cwd, target.sha);
    const urls = auditUrls(inputs.urls, target.deploymentUrl, preview || inputs.useDeploymentUrl);
    const entry = await measureEntry(inputs, api, target.sha, urls, bundle, budgets);

    if (target.kind === "preview") {
      const baseline = await readLatest(api, inputs.dataBranch, inputs.preset);
      const summary = summaryMarkdown(entry, baseline, { preview: { url: target.deploymentUrl } });
      const action = await api.upsertComment(issue as number, PREVIEW_HEADING, summary);
      core.info(`perf-trail: ${action} the preview comment on #${issue}`);
      await report(entry, summary);
    } else {
      const badgeDir = inputs.preset === "mobile" ? "badges" : `badges/${inputs.preset}`;
      const badges = Object.fromEntries(
        Object.entries(badgesFor(entry, budgets)).map(([path, svg]) => [
          `${badgeDir}/${path}`,
          svg,
        ]),
      );
      const { history, previous } = await saveEntry(api, {
        branch: inputs.dataBranch,
        entry,
        maxEntries: inputs.maxEntries,
        files: badges,
      });
      core.info(
        `perf-trail: saved ${entry.sha.slice(0, 7)} to ${inputs.dataBranch} (${history.length} entries)`,
      );
      await report(entry, summaryMarkdown(entry, previous));
      if (inputs.revalidateUrl) {
        const result = await revalidate(inputs.revalidateUrl, inputs.revalidateSecret);
        if (result.ok) core.info(result.message);
        else core.warning(result.message);
      }
    }

    if (entry.budgets && !entry.budgets.passed) {
      const failures = `Budgets failed:\n${entry.budgets.failures.map((f) => `  ${f}`).join("\n")}`;
      if (inputs.failOnBudget) core.setFailed(failures);
      else core.warning(failures);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

async function measureEntry(
  inputs: Inputs,
  api: GitHubApi,
  sha: string,
  urls: URL[],
  bundle: Bundle | undefined,
  budgets: Budgets | undefined,
): Promise<Entry> {
  const commit = await api.getCommit(sha);
  const runLighthouse = await installLighthouse(
    resolve(process.env.RUNNER_TEMP || tmpdir(), "perf-trail-lighthouse"),
    inputs.extraHeaders,
  );
  const pages: Record<string, PageResult> = {};
  for (const url of urls) {
    const { result, runs } = await core.group(`Lighthouse ${url.href}`, () =>
      measurePage(runLighthouse, url, inputs.preset, inputs.runs),
    );
    for (const [i, r] of runs.entries()) core.info(`run ${i + 1}: ${describe(r)}`);
    core.info(`median: ${describe(result)}`);
    pages[pageKey(url)] = result;
  }
  const message = inputs.storeCommitMessage ? firstLine(commit.message) : "";
  const measured = {
    v: 1,
    sha,
    date: new Date(commit.date).toISOString(),
    ...(message ? { message } : {}),
    url: (inputs.urls[0] as URL).origin,
    preset: inputs.preset,
    pages,
    ...(bundle ? { bundle } : {}),
  };
  return entrySchema.parse({
    ...measured,
    ...(budgets ? { budgets: evaluateBudgets(measured, budgets) } : {}),
  });
}

async function report(entry: Entry, summary: string): Promise<void> {
  core.setOutput("entry-json", JSON.stringify(entry));
  core.setOutput("summary-markdown", summary);
  core.setOutput("budget-passed", String(entry.budgets?.passed ?? true));
  await core.summary.addRaw(summary).write();
}

async function measureBuild(inputs: Inputs, cwd: string, sha: string): Promise<Bundle | undefined> {
  if (!inputs.bundle) return undefined;
  const head = await checkedOutSha(cwd);
  if (head === undefined) {
    throw new Error(
      `bundle needs the repository checked out in ${cwd}: add actions/checkout with ref set to the deployed sha`,
    );
  }
  if (head !== sha) {
    core.warning(
      `Checked out ${head.slice(0, 7)} but measuring ${sha.slice(0, 7)}: bundle sizes come from a different commit. Set ref on actions/checkout to the deployed sha.`,
    );
  }
  if (inputs.buildCommand) {
    await core.group(`Build: ${inputs.buildCommand}`, () =>
      runBuild(inputs.buildCommand as string, cwd),
    );
  }
  const measured = measureBundle(inputs.bundle, cwd);
  const bundle = inputs.bundleChunks
    ? {
        ...measured,
        chunks: { ...measured.chunks, ...(await readChunks(resolve(cwd, inputs.bundleChunks))) },
      }
    : measured;
  for (const [route, bytes] of Object.entries(bundle.routes)) {
    core.info(`bundle ${route}: ${(bytes / 1024).toFixed(1)} KiB gzip`);
  }
  return bundle;
}

async function readChunks(path: string): Promise<Record<string, number>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`bundle-chunks file ${path} is missing or not JSON: write it in build-command`);
  }
  const entries = Object.entries(typeof parsed === "object" && parsed !== null ? parsed : {});
  if (Array.isArray(parsed) || entries.some(([, v]) => !Number.isInteger(v) || (v as number) < 0)) {
    throw new Error(`bundle-chunks file ${path} must map names to gzip byte counts`);
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

async function readBudgets(path: string): Promise<Budgets> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`budgets file ${path} not found: check out the repository before perf-trail`);
  }
  try {
    return parseBudgets(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function skip(reason: string): void {
  core.info(`perf-trail: skipped, ${reason}`);
  core.setOutput("skipped", "true");
}

function describe({ scores, metrics }: PageResult): string {
  return `performance ${scores.performance}, LCP ${metrics.lcp} ms, CLS ${metrics.cls}, TBT ${metrics.tbt} ms`;
}
