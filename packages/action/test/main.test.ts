import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Lhr } from "../src/lighthouse.ts";
import { type FakeBranch, fakeGitHub } from "./fake-github.ts";

const state = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  outputs: {} as Record<string, string>,
  logs: [] as string[],
  warnings: [] as string[],
  failed: undefined as string | undefined,
  context: { eventName: "", payload: {} as unknown, sha: "", repo: { owner: "o", repo: "r" } },
  audited: [] as string[],
  branches: {} as Record<string, FakeBranch>,
  summary: "",
  head: undefined as string | undefined,
  builds: [] as string[],
}));

vi.mock("@actions/core", () => ({
  getInput: (name: string) => state.inputs[name] ?? "",
  setOutput: (name: string, value: string) => {
    state.outputs[name] = value;
  },
  info: (message: string) => state.logs.push(message),
  warning: (message: string) => state.warnings.push(message),
  setFailed: (message: string) => {
    state.failed = message;
  },
  group: async <T>(_name: string, fn: () => Promise<T>) => fn(),
  summary: {
    addRaw(text: string) {
      state.summary += text;
      return this;
    },
    write: async () => {},
  },
}));

vi.mock("../src/build.ts", () => ({
  checkedOutSha: async () => state.head,
  runBuild: async (command: string) => {
    state.builds.push(command);
  },
}));

vi.mock("@actions/github", () => ({
  context: state.context,
}));

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/lhr-example-com.json", import.meta.url), "utf8"),
) as Lhr;

vi.mock("../src/lighthouse.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lighthouse.ts")>();
  return {
    ...original,
    installLighthouse: async () => async (url: URL) => {
      state.audited.push(url.href);
      return fixture;
    },
  };
});

const gh = vi.hoisted(() => ({ current: undefined as ReturnType<typeof fakeGitHub> | undefined }));

vi.mock("../src/github.ts", () => ({
  createGitHubApi: () => gh.current?.api,
}));

const { run } = await import("../src/main.ts");

const SHA = "abcdef1234567890";

beforeEach(() => {
  state.inputs = {
    urls: "https://example.com/en\nhttps://example.com/en/cv",
    runs: "2",
    "github-token": "t",
  };
  state.outputs = {};
  state.logs = [];
  state.warnings = [];
  state.failed = undefined;
  state.audited = [];
  state.summary = "";
  state.head = SHA;
  state.builds = [];
  process.env.GITHUB_WORKSPACE = workspace();
  Object.assign(state.context, { eventName: "workflow_dispatch", payload: {}, sha: SHA });
  gh.current = fakeGitHub();
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "perf-trail-action-"));
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "app.js"), "console.log(1);".repeat(400));
  return dir;
}

const savedFile = (path: string) => gh.current?.branches.get("perf-data")?.files[path];

const savedHistory = () =>
  JSON.parse(gh.current?.branches.get("perf-data")?.files["history.json"] ?? "null") as unknown[];

describe("run", () => {
  it("measures every url and saves an entry", async () => {
    await run();
    expect(state.failed).toBeUndefined();
    expect(state.audited).toEqual([
      "https://example.com/en",
      "https://example.com/en",
      "https://example.com/en/cv",
      "https://example.com/en/cv",
    ]);
    expect(savedHistory()).toEqual([
      {
        v: 1,
        sha: SHA,
        date: "2026-10-01T08:00:00.000Z",
        message: "feat: change abcdef1",
        url: "https://example.com",
        preset: "mobile",
        pages: {
          "/en": expect.objectContaining({ scores: expect.objectContaining({ performance: 93 }) }),
          "/en/cv": expect.objectContaining({ metrics: expect.objectContaining({ lcp: 962 }) }),
        },
      },
    ]);
    expect(state.outputs.skipped).toBe("false");
    expect(JSON.parse(state.outputs["entry-json"] ?? "{}").sha).toBe(SHA);
  });

  it("omits the commit message when asked", async () => {
    state.inputs["store-commit-message"] = "false";
    await run();
    expect(savedHistory()[0]).not.toHaveProperty("message");
  });

  it("skips a preview deployment with a log line", async () => {
    Object.assign(state.context, {
      eventName: "deployment_status",
      payload: {
        deployment_status: { state: "success" },
        deployment: { sha: SHA, environment: "Preview" },
      },
    });
    await run();
    expect(state.outputs.skipped).toBe("true");
    expect(state.logs.join("\n")).toContain('perf-trail: skipped, environment "Preview"');
    expect(state.audited).toEqual([]);
    expect(gh.current?.commits).toEqual([]);
  });

  it("fails on invalid inputs", async () => {
    state.inputs.preset = "tablet";
    await run();
    expect(state.failed).toContain("preset");
  });

  it("warns but does not fail when revalidation fails", async () => {
    state.inputs["revalidate-url"] = "https://example.com/api/revalidate";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 500 }));
    await run();
    fetchSpy.mockRestore();
    expect(state.failed).toBeUndefined();
    expect(state.warnings.join("\n")).toContain("HTTP 500");
    expect(savedHistory()).toHaveLength(1);
  });
});

describe("run with bundle, budgets and badges", () => {
  const budgets = (value: unknown) =>
    writeFileSync(
      join(process.env.GITHUB_WORKSPACE as string, "budgets.json"),
      JSON.stringify(value),
    );

  it("builds, measures the bundle and writes badges and a summary", async () => {
    Object.assign(state.inputs, { bundle: "glob:dist/*.js", "build-command": "make" });
    await run();
    expect(state.failed).toBeUndefined();
    expect(state.builds).toEqual(["make"]);
    const [entry] = savedHistory() as { bundle: { routes: Record<string, number> } }[];
    expect(entry?.bundle.routes["dist/*.js"]).toBeGreaterThan(0);
    expect(savedFile("badges/performance.svg")).toContain("Lighthouse: 93");
    expect(savedFile("badges/pages/en-cv/lcp.svg")).toContain("LCP: 0.96 s");
    expect(savedFile("badges/js.svg")).toContain("JS: ");
    expect(state.summary).toContain("| `/en` | 93 | 96 | 100 | 80 | 962 ms |");
    expect(state.outputs["summary-markdown"]).toBe(state.summary);
    expect(state.outputs["budget-passed"]).toBe("true");
  });

  it("warns when the checkout is not the measured commit", async () => {
    state.inputs.bundle = "glob:dist/*.js";
    state.head = "0000000aaaa";
    await run();
    expect(state.warnings.join("\n")).toContain("bundle sizes come from a different commit");
  });

  it("fails without a checkout when the bundle is measured", async () => {
    state.inputs.bundle = "glob:dist/*.js";
    state.head = undefined;
    await run();
    expect(state.failed).toContain("actions/checkout");
  });

  it("saves the entry first and then fails on a broken budget", async () => {
    budgets({ scores: { performance: 95 } });
    state.inputs.budgets = "budgets.json";
    await run();
    expect(savedHistory()[0]).toMatchObject({
      budgets: {
        passed: false,
        failures: ["/en performance 93 < 95", "/en/cv performance 93 < 95"],
      },
    });
    expect(state.outputs["budget-passed"]).toBe("false");
    expect(state.summary).toContain("**Budgets failed:**");
    expect(state.failed).toContain("/en performance 93 < 95");
  });

  it("only warns on a broken budget when fail-on-budget is false", async () => {
    budgets({ scores: { performance: 95 } });
    Object.assign(state.inputs, { budgets: "budgets.json", "fail-on-budget": "false" });
    await run();
    expect(state.failed).toBeUndefined();
    expect(state.warnings.join("\n")).toContain("Budgets failed");
  });

  it("rejects an invalid budgets file before measuring", async () => {
    budgets({ scores: { speed: 1 } });
    state.inputs.budgets = "budgets.json";
    await run();
    expect(state.failed).toContain("invalid budgets");
    expect(state.audited).toEqual([]);
  });

  it("keeps desktop badges apart", async () => {
    state.inputs.preset = "desktop";
    await run();
    expect(savedFile("badges/desktop/performance.svg")).toBeDefined();
    expect(savedFile("badges/performance.svg")).toBeUndefined();
  });
});

describe("bundle-chunks", () => {
  const write = (value: unknown) =>
    writeFileSync(
      join(process.env.GITHUB_WORKSPACE as string, "chunks.json"),
      JSON.stringify(value),
    );

  it("merges named chunk sizes into the bundle", async () => {
    write({ editor: 16_896 });
    Object.assign(state.inputs, { bundle: "glob:dist/*.js", "bundle-chunks": "chunks.json" });
    await run();
    expect(state.failed).toBeUndefined();
    const [entry] = savedHistory() as { bundle: { chunks: Record<string, number> } }[];
    expect(entry?.bundle.chunks.editor).toBe(16_896);
    expect(entry?.bundle.chunks["dist/app.js"]).toBeGreaterThan(0);
  });

  it("rejects values that are not byte counts", async () => {
    write({ editor: 16.5 });
    Object.assign(state.inputs, { bundle: "glob:dist/*.js", "bundle-chunks": "chunks.json" });
    await run();
    expect(state.failed).toContain("must map names to gzip byte counts");
  });
});

describe("preview comments", () => {
  const previewEvent = () =>
    Object.assign(state.context, {
      eventName: "deployment_status",
      payload: {
        deployment_status: {
          state: "success",
          environment_url: "https://site-git-feature.vercel.app",
        },
        deployment: { sha: SHA, environment: "Preview" },
      },
    });

  it("skips previews unless preview-comment is on", async () => {
    previewEvent();
    await run();
    expect(state.outputs.skipped).toBe("true");
    expect(state.audited).toEqual([]);
  });

  it("measures the preview URL, comments on the PR and leaves history alone", async () => {
    previewEvent();
    state.inputs["preview-comment"] = "true";
    gh.current?.pulls.set(SHA, 42);
    await run();
    expect(state.failed).toBeUndefined();
    expect(state.audited[0]).toBe("https://site-git-feature.vercel.app/en");
    expect(gh.current?.commits).toEqual([]);
    const [comment] = gh.current?.comments.get(42) ?? [];
    expect(comment).toContain("### perf-trail preview: abcdef1 (mobile)");
    expect(comment).toContain("Measured on https://site-git-feature.vercel.app");
    expect(comment).toContain("No production entry yet");
  });

  it("updates the same comment and compares with production", async () => {
    const production = {
      v: 1,
      sha: "1111111aaaa",
      date: "2026-09-30T00:00:00.000Z",
      url: "https://example.com",
      preset: "mobile",
      pages: {
        "/en": {
          scores: { performance: 90, accessibility: 96, bestPractices: 100, seo: 80 },
          metrics: { lcp: 1200, cls: 0, tbt: 300, fcp: 779, si: 779 },
        },
      },
    };
    gh.current = fakeGitHub({
      "perf-data": { head: "h1", files: { "history.json": JSON.stringify([production]) } },
    });
    previewEvent();
    state.inputs["preview-comment"] = "true";
    gh.current.pulls.set(SHA, 7);
    await run();
    await run();
    const list = gh.current.comments.get(7) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]).toContain("| `/en` | 93 (+3)");
    expect(list[0]).toContain("Deltas compare with production 1111111");
  });

  it("skips when no pull request contains the commit", async () => {
    previewEvent();
    state.inputs["preview-comment"] = "true";
    await run();
    expect(state.logs.join("\n")).toContain("no pull request contains abcdef1");
    expect(state.audited).toEqual([]);
  });
});

describe("pull request opened after the preview deployed", () => {
  const prEvent = () =>
    Object.assign(state.context, {
      eventName: "pull_request",
      payload: { action: "opened", pull_request: { number: 9, head: { sha: SHA } } },
    });

  it("finds the finished preview deployment and comments", async () => {
    prEvent();
    state.inputs["preview-comment"] = "true";
    gh.current?.previews.set(SHA, {
      url: "https://site-git-late.vercel.app",
      environment: "Preview",
    });
    await run();
    expect(state.failed).toBeUndefined();
    expect(state.audited[0]).toBe("https://site-git-late.vercel.app/en");
    expect(gh.current?.comments.get(9)?.[0]).toContain(
      "Measured on https://site-git-late.vercel.app",
    );
    expect(gh.current?.commits).toEqual([]);
  });

  it("skips until a preview deployment exists", async () => {
    prEvent();
    state.inputs["preview-comment"] = "true";
    await run();
    expect(state.outputs.skipped).toBe("true");
    expect(state.logs.join("\n")).toContain("no successful preview deployment for abcdef1 yet");
    expect(state.audited).toEqual([]);
  });
});
