import type { Metadata } from "next";
import { Code } from "../_components/code";
import { REPO } from "../_lib/history";

export const metadata: Metadata = {
  title: "Docs",
  description:
    "Inputs, bundle sizes, budgets, badges, React components and recipes for perf-trail.",
};

const inputs: [string, string, string][] = [
  ["urls", "required", "Newline list of URLs to audit, all on one origin."],
  ["runs", "3", "Lighthouse runs per URL. The median run is stored."],
  ["preset", "mobile", "mobile or desktop. Desktop entries and badges are kept apart."],
  ["bundle", "off", "next, vite, glob:<pattern> or off."],
  [
    "build-command",
    "none",
    "Shell command run in working-directory before the bundle is measured.",
  ],
  ["working-directory", ".", "Where the app is built, relative to the repository root."],
  ["budgets", "none", "Path to perf-trail.budgets.json, relative to the repository root."],
  [
    "bundle-chunks",
    "none",
    "JSON file of extra named gzip sizes in bytes, written by your build-command and merged into bundle.chunks.",
  ],
  ["fail-on-budget", "true", "Fail the job on a missed budget. The entry is saved first."],
  [
    "data-branch",
    "perf-data",
    "Branch that stores history.json and badges. Created on the first run.",
  ],
  ["max-entries", "300", "How many entries the history keeps."],
  ["environment-prefix", "Production", "deployment_status environments that are measured."],
  ["use-deployment-url", "false", "Audit the per-deployment URL from the event instead of urls."],
  [
    "store-commit-message",
    "true",
    "Store the first line of the commit message, at most 100 characters.",
  ],
  ["revalidate-url", "none", "URL to POST after the history is saved."],
  ["revalidate-secret", "none", "Sent to revalidate-url as Authorization: Bearer <secret>."],
  [
    "preview-comment",
    "false",
    "Comment on pull requests for preview deployments. Needs pull-requests: write.",
  ],
  ["preview-environment-prefix", "Preview", "Deployment environments treated as previews."],
  ["extra-headers", "none", "JSON object of headers Lighthouse sends, masked in logs."],
  ["github-token", "github.token", "Needs contents: write."],
];

const outputs: [string, string][] = [
  ["skipped", "true when the event was not measured, for example a preview deployment."],
  ["entry-json", "The saved entry."],
  ["budget-passed", "false when a budget was missed."],
  ["summary-markdown", "The job summary table with deltas."],
];

const fullWorkflow = `name: Perf
on:
  deployment_status:
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: perf-trail
  cancel-in-progress: false
jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          ref: \${{ github.event.deployment.sha || github.sha }}
      - uses: actions/setup-node@v5
        with:
          node-version: 24
      - run: npm ci
      - uses: bvffblvde/perf-trail@v1
        with:
          urls: |
            https://your-site.com/
            https://your-site.com/pricing
          build-command: npm run build
          bundle: next
          budgets: perf-trail.budgets.json`;

const budgets = `{
  "$schema": "https://raw.githubusercontent.com/bvffblvde/perf-trail/main/packages/core/schema/budgets.v1.json",
  "scores": { "performance": 95, "accessibility": 100, "bestPractices": 95, "seo": 100 },
  "metrics": { "lcp": 2500, "cls": 0.05, "tbt": 200 },
  "pages": { "/pricing": { "metrics": { "lcp": 3000 } } },
  "bundle": { "maxKiB": 160, "routes": { "/dashboard": 300 } }
}`;

const pagesWorkflow = `on:
  push:
    branches: [main]
jobs:
  perf:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: bvffblvde/perf-trail@v1
        with:
          urls: https://you.github.io/your-site/`;

const previewWorkflow = `on:
  deployment_status:
  pull_request:
    types: [opened, reopened, ready_for_review]
permissions:
  contents: write
  pull-requests: write
  deployments: read
jobs:
  perf:
    runs-on: ubuntu-latest
    steps:
      - uses: bvffblvde/perf-trail@v1
        with:
          urls: https://your-site.com/
          preview-comment: true
          extra-headers: '{"x-vercel-protection-bypass": "\${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}"}'`;

const privateRead = `const history = await fetchHistory({
  repo: "you/private-site",
  token: process.env.PERF_READ_TOKEN,
  init: { next: { revalidate: 3600, tags: ["perf"] } },
});`;

const revalidateRoute = `import { revalidateTag } from "next/cache";

export async function POST(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== \`Bearer \${process.env.REVALIDATE_SECRET}\`) {
    return new Response(null, { status: 401 });
  }
  revalidateTag("perf", { expire: 0 });
  return Response.json({ revalidated: true });
}`;

export default function Docs() {
  return (
    <article className="docs">
      <h1>Docs</h1>
      <p>
        Everything the action, the history format and the packages do. The source is on{" "}
        <a href={`https://github.com/${REPO}`}>GitHub</a>.
      </p>
      <nav className="toc" aria-label="On this page">
        <a href="#workflow">Workflow</a>
        <a href="#inputs">Inputs</a>
        <a href="#bundle">Bundle sizes</a>
        <a href="#budgets">Budgets</a>
        <a href="#badges">Badges</a>
        <a href="#render">Rendering</a>
        <a href="#recipes">Recipes</a>
        <a href="#format">History format</a>
      </nav>

      <h2 id="workflow">Workflow</h2>
      <p>
        perf-trail runs on three events. deployment_status measures successful deployments whose
        environment starts with Production and skips the rest with a log line. push and
        workflow_dispatch always measure the current commit. Check out the deployed sha when you
        measure the bundle, otherwise the checkout is your default branch.
      </p>
      <Code code={fullWorkflow} label=".github/workflows/perf.yml" language="yaml" />

      <h2 id="inputs">Inputs</h2>
      <div className="table">
        <table>
          <thead>
            <tr>
              <th scope="col">Input</th>
              <th scope="col">Default</th>
              <th scope="col">What it does</th>
            </tr>
          </thead>
          <tbody>
            {inputs.map(([name, value, text]) => (
              <tr key={name}>
                <th scope="row">
                  <code>{name}</code>
                </th>
                <td>
                  <code>{value}</code>
                </td>
                <td>{text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Outputs</h3>
      <ul>
        {outputs.map(([name, text]) => (
          <li key={name}>
            <code>{name}</code>: {text}
          </li>
        ))}
      </ul>

      <h2 id="bundle">Bundle sizes</h2>
      <p>
        The action sums the gzip size of the JavaScript each route loads on first visit. Nothing is
        uploaded; the numbers come from your build output.
      </p>
      <ul>
        <li>
          <code>next</code> reads the App Router manifests in .next, for Turbopack and webpack
          builds. Route keys are patterns such as /[locale]/blog/[slug]. The Pages Router is not
          supported yet.
        </li>
        <li>
          <code>vite</code> reads dist/.vite/manifest.json. Set build.manifest to true. Each entry
          counts its static imports; dynamic imports are left out.
        </li>
        <li>
          <code>{"glob:dist/**/*.js"}</code> reports the total under the pattern plus every file.
        </li>
      </ul>
      <p>
        If the build output has a format the adapter does not know, the run fails with a clear
        message instead of recording a wrong number.
      </p>

      <h2 id="budgets">Budgets</h2>
      <p>
        Scores are minimums, metrics and JS are maximums. Metrics are in milliseconds, CLS is
        unitless, JS is in KiB. Pages and routes can override the defaults. A missed budget is
        recorded in the entry, shown in the job summary, and fails the job after saving unless
        fail-on-budget is false.
      </p>
      <Code code={budgets} label="perf-trail.budgets.json" language="json" />

      <h2 id="badges">Badges</h2>
      <p>
        Every run writes SVG badges to badges/ in the data branch: performance.svg and lcp.svg for
        the first URL, js.svg for the largest route, and badges/pages/&lt;page&gt;/ for each page.
        Desktop runs write to badges/desktop/. Link them from raw.githubusercontent.com.
      </p>

      <h2 id="render">Rendering</h2>
      <p>
        @perf-trail/client reads history.json from the data branch. @perf-trail/react renders it on
        the server with no client JavaScript.
      </p>
      <ul>
        <li>
          <code>PerfHistoryChart</code>: metric is lcp, cls, tbt, fcp, si, a score key or js. Takes
          page, route, preset and budget. Renders an SVG with role="img" and a text summary. Add
          interactive for focusable points with tooltips; it is the only part that ships client
          JavaScript.
        </li>
        <li>
          <code>LatestDeployCard</code>: scores and metrics of the newest entry with deltas against
          the previous one.
        </li>
        <li>
          <code>PerfHistoryTable</code>: the last deploys, newest first.
        </li>
      </ul>
      <p>
        Import @perf-trail/react/styles.css and theme with CSS variables such as --pt-line,
        --pt-good and --pt-poor. Colors follow your page's color-scheme. Every component takes
        labels: translated strings plus a locale for dates.
      </p>

      <h2 id="recipes">Recipes</h2>
      <h3>Vercel</h3>
      <p>
        Vercel reports deployments to GitHub, so deployment_status works out of the box. Keep urls
        on your production domain: per-deployment URLs can sit behind Deployment Protection. To
        refresh the page right after a run, add a route and pass its URL as revalidate-url.
      </p>
      <Code code={revalidateRoute} label="app/api/revalidate/route.ts" language="ts" />
      <h3>Netlify</h3>
      <p>
        Netlify also creates GitHub deployments for production deploys. Its environment is named
        Production, which matches the default environment-prefix.
      </p>
      <h3>GitHub Pages and other hosts</h3>
      <p>Run perf-trail after your deploy job on push.</p>
      <Code code={pagesWorkflow} label=".github/workflows/pages.yml" language="yaml" />
      <h3>Pull request previews</h3>
      <p>
        Turn on preview-comment and the same workflow measures successful preview deployments, finds
        the pull request that contains the commit, and keeps one comment on it up to date, compared
        with the latest production entry. Previews never write to the history. Vercel previews need
        a Protection Bypass for Automation secret, sent as a header. The pull_request trigger covers
        a pull request opened after its preview already deployed.
      </p>
      <Code code={previewWorkflow} label="preview comments" language="yaml" />
      <h3>Private repositories</h3>
      <p>
        Pass a fine-grained token with read access to contents. The client then reads through the
        GitHub API.
      </p>
      <Code code={privateRead} label="read a private history" language="ts" />

      <h2 id="format">History format</h2>
      <p>
        history.json is an array of version 1 entries, oldest first. Breaking changes will only ship
        as version 2 with a migration in @perf-trail/core. The JSON Schema is published at{" "}
        <a href={`https://github.com/${REPO}/blob/main/packages/core/schema/history.v1.json`}>
          packages/core/schema/history.v1.json
        </a>
        .
      </p>
    </article>
  );
}
