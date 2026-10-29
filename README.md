# Rack BOM Review Agent

An AI agent on Cloudflare that reviews a manufacturer's (ODM's) rack Bill of Materials against the rack spec before the build is released. It flags build blockers, pauses so a human can approve the findings, and then drafts the escalation note to the ODM. You can chat with it about the review, for example "why did you flag line 21?".

Built on the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) for the optional assignment on Cloudflare's Rack Integration Operations Engineer posting. **All data in this repo is synthetic.**

## Contents

- [Why this exists](#why-this-exists)
- [What it does](#what-it-does)
- [Design principle](#design-principle)
- [How it maps to the assignment](#how-it-maps-to-the-assignment)
- [Architecture](#architecture)
- [Run it locally](#run-it-locally)
- [Deploy](#deploy)
- [Choosing a model](#choosing-a-model)
- [Rack specs (the gold standard)](#rack-specs-the-gold-standard)
- [Input formats](#input-formats)
- [Findings and severity](#findings-and-severity)
- [Demo data](#demo-data)
- [Testing](#testing)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Limitations and next steps](#limitations-and-next-steps)
- [Prompt history](#prompt-history)

## Why this exists

At Qorvo I built a checklist for reviewing first article inspection packages against drawings, specs and material certs. It caught missing dimensional results, unaddressed GD&T callouts, and certs that did not match the drawing revision. At Samsung I standardized BOM governance and built vendor lead-time dashboards. Both were the same job done by hand: compare what a supplier sent against what the spec says, then chase the gaps.

This project automates that review for a data center rack. It targets the posting's responsibility to "review and validate complex BOMs prior to release to integration partners, proactively identifying part substitutions, spec mismatches, and potential build blockers."

## What it does

1. **Intake.** Validates the spec, BOM, cert list and build context, and reports every problem at once.
2. **Rule checks (code).** Checks revision, quantity, approved vendor, approved substitutes, cert drawing revision, lead time against the need-by date, and rack power.
3. **LLM judgment.** Only for BOM lines the rules cannot place. The model decides whether an off-spec part substitutes for a missing spec part, and how risky the swap is.
4. **Approval gate.** The workflow pauses. The reviewer approves or rejects each finding, can change its severity, edit the suggested action, or add a note. The verdict (READY or HOLD) updates live.
5. **Escalation note.** Once approved, the workflow resumes and drafts a note to the ODM from the approved, actionable findings only.
6. **Editable specs.** Rack specs live in a versioned library you can edit when a spec changes, or extend with new rack designs.
7. **Chat.** Answers questions about the review and cites BOM line numbers and finding IDs.
8. **Audit log and usage meter.** Every step and decision is timestamped. Every LLM call is counted with tokens and estimated cost.

## Design principle

**Exact checks run in plain code. The LLM only does fuzzy judgment and writing.**

LLMs are unreliable at arithmetic and exact matching, and code is not. So:

| Question                                                               | Answered by                            |
| ---------------------------------------------------------------------- | -------------------------------------- |
| Does the revision match the spec?                                      | code                                   |
| Is the quantity right? (summed across split lines)                     | code                                   |
| Is the manufacturer approved? Is this an approved substitute?          | code                                   |
| Does the cert reference the current drawing revision?                  | code                                   |
| Will the part arrive before the need-by date?                          | code                                   |
| Is the rack within its power budget?                                   | code                                   |
| Is this off-spec part a substitute for a missing one? How risky is it? | LLM, returning JSON validated with zod |
| Write the escalation note to the ODM                                   | LLM, returning JSON validated with zod |

**The app still works if the model is weak or missing.** If a model call fails or returns invalid JSON, off-spec lines go to the reviewer as "needs review" and the note is built from a code template. You can run the whole flow with no LLM at all (`npm run dev:local`).

## How it maps to the assignment

| Requirement             | Implementation                                                                                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM                     | Workers AI, Llama 3.3 70B by default, switchable in the UI. All model IDs live in one registry, [`src/config.ts`](src/config.ts).                                                   |
| Workflow / coordination | A Cloudflare Workflow ([`src/workflow.ts`](src/workflow.ts)) started by the agent. Its durable steps are intake → rules → LLM judgment → **pause for human approval** → draft note. |
| User input via chat     | React chat panel using `useAgentChat`, streaming from the agent.                                                                                                                    |
| Memory / state          | One `ReviewAgent` Durable Object per build ID, backed by SQLite. It holds findings, reviewer decisions, the audit log, chat history, the selected model and usage records.          |

## Architecture

```
Browser (React + Kumo UI)
  │  one WebSocket per build: state sync, @callable RPC, chat stream
  ▼
ReviewAgent  (AIChatAgent / Durable Object, named by build ID) ◄── getCurrent(specId) ── SpecLibrary
  │  runWorkflow · approveWorkflow · rejectWorkflow                (Durable Object: every rack
  ▼                                                                 spec + revision history)
ReviewWorkflow  (AgentWorkflow)
  intake ─► rules ─► llm-judge ─► publish-findings ─► waitForApproval ─► draft-note
              │          │                                                   │
          plain code     └───────────── Workers AI / Anthropic ◄─────────────┘
```

- **Agent ([`src/server.ts`](src/server.ts)).** Validates input, starts the workflow, and exposes `@callable` methods to the UI: `loadDemo`, `startReview`, `submitDecisions`, `rejectReview`, `setModel`, `listModels`. Clients cannot write state directly (`validateStateChange` rejects it). Every change goes through a method and lands in the audit log.
- **Spec library ([`src/spec-agent.ts`](src/spec-agent.ts), [`src/spec-library.ts`](src/spec-library.ts)).** One Durable Object holds every rack spec and its revision history. Reviews fetch the current revision over agent-to-agent RPC and keep a snapshot, so later edits never change a finished review. See [Rack specs](#rack-specs-the-gold-standard).
- **Workflow ([`src/workflow.ts`](src/workflow.ts)).** Each `step.do` result is persisted, so a retry or restart never re-runs a finished step or double-counts LLM usage. The workflow reports back to the agent over typed RPC. `waitForApproval` holds it for up to 7 days.
- **Chat.** The whole review (findings plus the submitted BOM, about 2k tokens) goes in the system prompt rather than being fetched through tool calls. In testing, Llama 3.3 looped on tool calls or leaked tool-call JSON as text. Putting the data in context works the same on every model in the picker.

## Run it locally

Requires Node 20+ and a Cloudflare account (the free plan works with the default model).

```bash
npm install
npx wrangler login
npm run dev
```

Open http://localhost:5173, choose **Demo: 6 planted issues**, and click **Run review**.

Workers AI has no local runtime, so even local dev calls it remotely; that's why `wrangler login` is needed.

**No Cloudflare account?** This runs everything except the LLM, so you see the fallbacks in action:

```bash
npm run dev:local
```

**Your own files:** click **Upload**, pick a rack spec from the library (or upload a `spec.json`), and provide `bom.csv`, `certs.csv` and `context.json`. Their formats are in [Input formats](#input-formats). The `buildId` in `context.json` names the review, and each build gets its own agent instance.

## Deploy

```bash
npm run deploy
```

This builds the UI and deploys the Worker, Durable Object and Workflow in one step. Wrangler prints the URL.

## Choosing a model

Pick a model from the dropdown in the app header. The choice is saved per review and recorded in the audit log, and each LLM finding and note records which model produced it.

| Model                     | ID                                         | Needs                                          | List price per 1M tokens (in / out) |
| ------------------------- | ------------------------------------------ | ---------------------------------------------- | ----------------------------------- |
| Llama 3.3 70B _(default)_ | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | nothing extra                                  | $0.293 / $2.253                     |
| Llama 4 Scout 17B         | `@cf/meta/llama-4-scout-17b-16e-instruct`  | nothing extra                                  | $0.27 / $0.85                       |
| Kimi K2.6                 | `@cf/moonshotai/kimi-k2.6`                 | Workers Paid plan                              | $0.95 / $4.00                       |
| Claude Opus 5.5           | `claude-opus-5-5`                          | `ANTHROPIC_API_KEY` secret (hidden without it) | $4.00 / $20.00                      |

Prices were checked against provider pricing pages on 2026-10-28.

- **Enable Claude:** run `npx wrangler secret put ANTHROPIC_API_KEY`. For local dev, copy `.dev.vars.example` to `.dev.vars` and fill in the key.
- **Change the default model** for new reviews: edit `DEFAULT_MODEL` in [`wrangler.jsonc`](wrangler.jsonc).
- **Add a model:** add an entry to `MODELS` in [`src/config.ts`](src/config.ts).

**Usage meter.** The header shows LLM calls, tokens in and out, and estimated cost. Click it for a breakdown by model and by call type (judge, draft, chat). A full review of the demo BOM with Llama 3.3 costs about $0.0015. The rule checks always show 0 LLM calls. Costs use list prices and don't subtract the Workers AI free allowance.

## Rack specs (the gold standard)

The spec is what every BOM is checked against. It lists the required parts, revisions, quantities, wattage, approved manufacturers and substitutes, plus the rack power budget. Click **Rack specs** in the header to manage it.

- **Edit a spec** when it changes (an ECO), directly in the parts table. You can change any field, add or remove parts, and edit approved manufacturers (comma-separated) and approved substitutes (`PART | manufacturer | rev`, separated by semicolons).
- **Changes need a new revision label.** If you edit without changing the revision, saving is blocked and a **Bump to D** button appears. Revision labels can't be reused, and saving with no changes is refused. This way the gold standard never changes silently.
- **Preview before saving.** Validation and a list of changes update as you type, for example `RK-CBL-PWR-C19: qty 36 → 38`. Add a change note, such as an ECO number.
- **Revision history.** Every saved revision is kept with its time, note and change list, and each can be downloaded as JSON.
- **Scale to other racks.** Use **New rack spec**, or **Duplicate as new rack** to start from an existing design. Each spec has its own ID, such as `RS-STORAGE-42U`, and appears in the Upload form's spec picker.
- **Import and export** `spec.json`. An import with a known spec ID opens as an edit to that spec; a new ID opens as a new spec.

**How reviews use specs.** A review uses the library's current revision and keeps a snapshot of it, so editing a spec never changes a review that already ran. If a BOM's `context.json` names an older revision than the library's current one, the review raises a `spec-revision` blocker. Every line is still checked against the current spec, so you can see what the ECO breaks. For example, raising the C19 cable count to 38 makes line 21 of the clean demo short by 2.

The library starts with the demo spec (`RS-COMPUTE-48U` rev C). Saves use the same validation as an uploaded spec, plus a few extra checks: no blank fields, a `specId` of letters, digits and dashes only, and no part number listed twice. The validation and revision rules are pure functions in [`src/spec-library.ts`](src/spec-library.ts), with unit tests.

## Input formats

Exact examples are in [`demo/`](demo/).

**`spec.json`:** the reference for one rack design.

```json
{
  "specId": "RS-COMPUTE-48U",
  "revision": "C",
  "rackName": "48U compute rack, 16-node",
  "powerBudgetW": 17000,
  "parts": [
    {
      "partNumber": "RK-PDU-30A-3P",
      "description": "Switched PDU, 30A 3-phase",
      "revision": "D",
      "qtyPerRack": 2,
      "wattsEach": 20,
      "approvedManufacturers": ["Northwind Power"],
      "approvedSubstitutes": [
        { "partNumber": "...", "manufacturer": "...", "revision": "..." }
      ]
    }
  ]
}
```

**`bom.csv`:** what the ODM submitted.

```
line,part_number,description,manufacturer,quantity,revision,lead_time_days,cert_ref
```

`lead_time_days` may be blank; it's flagged as missing data.

**`certs.csv`:** the cert package, standing in for first article inspection reports.

```
cert_ref,part_number,drawing_revision,issued
```

**`context.json`:** the build.

```json
{
  "buildId": "BLD-2026-0412",
  "odm": "Fabrikon Integration (synthetic ODM)",
  "specRevision": "C",
  "needBy": "2026-12-15",
  "asOf": "2026-10-28"
}
```

`asOf` is the date the review is run "as of". Lead times are counted from it, so results are reproducible. If `specRevision` differs from the spec's current revision, the review raises a `spec-revision` blocker; it isn't rejected at intake.

`spec.json` is optional when you pick a spec from the library.

## Findings and severity

Each finding looks like this:

```json
{
  "id": "F-04",
  "line": 21,
  "partNumber": "RK-CBL-PWR-C19",
  "category": "quantity",
  "severity": "blocker",
  "expected": "36 per rack",
  "found": "32",
  "evidence": "Spec rev C requires 36; BOM is short by 4.",
  "suggestedAction": "Add 4 x RK-CBL-PWR-C19.",
  "source": "rule",
  "status": "pending"
}
```

| Category            | Raised when                                                         | Severity                                           |
| ------------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| `revision-mismatch` | BOM revision differs from the spec (or the approved substitute's)   | blocker                                            |
| `vendor`            | Spec part number from a manufacturer not on the approved list       | blocker                                            |
| `quantity`          | Total per part is short, or a required part is missing              | blocker                                            |
| `quantity`          | Total per part is over                                              | needs review                                       |
| `cert`              | Cert is for a different part, or references an old drawing revision | blocker                                            |
| `lead-time`         | `asOf` + lead time lands after need-by                              | blocker                                            |
| `power`             | Rack draw exceeds the budget / is above 90% of it                   | blocker / info                                     |
| `substitution`      | Approved substitute used                                            | info                                               |
| `substitution`      | LLM judges an off-spec part to be a substitute                      | needs review (blocker if high risk)                |
| `not-in-spec`       | Off-spec part that substitutes for nothing                          | blocker (needs review if the model is unavailable) |
| `spec-revision`     | BOM was prepared against an older spec revision                     | blocker                                            |
| `missing-data`      | Blank lead time, blank cert reference, or cert not in the package   | needs review                                       |

**Verdict:** HOLD if any blocker the reviewer hasn't rejected, otherwise READY.

**ODM note:** includes approved findings except info.

## Demo data

The **planted-issues BOM** (build `BLD-2026-0412`, 39 lines) contains:

1. A PDU on revision C where the spec requires D (line 2).
2. A transceiver swapped for an unapproved vendor's part (line 15). The LLM judges it a substitution.
3. Power cables short by 4 (line 21).
4. A switch cert issued against an old drawing revision (line 12).
5. An SSD whose lead time lands 27 days after need-by (line 8).
6. A rack light bar that is not in the spec (line 39). The LLM separates it from the substitution.

It also contains two items reported as info: an approved DAC substitute (line 17) and rack power at 93% of budget. It also splits the DIMMs across two lines, to show quantities being summed.

With Llama 3.3 the expected result is **HOLD: 5 blockers, 1 needs review, 2 info**.

The **clean BOM** (build `BLD-2026-0413`) comes back **READY** with no LLM call, because nothing is off-spec.

Part numbers, manufacturers and the ODM are invented. [DEMO.md](DEMO.md) has a 3-minute walkthrough.

**A larger test set** lives in [`demo/test-bom-50/`](demo/test-bom-50/): a 50-line BOM (build `BLD-2026-0507`) with 8 issues placed at random. Upload its four files in the app, and check the results against [`ANSWER_KEY.md`](demo/test-bom-50/ANSWER_KEY.md). To generate a different layout, run `node scripts/make-test-bom.mjs <seed>`. A unit test checks the key against the rules.

## Testing

```bash
npm test
```

48 unit tests cover:

- one test per planted issue, plus the exact expected list of findings;
- the clean BOM;
- edge cases: power over budget and at the 90% threshold, lead time landing exactly on need-by, missing data, unapproved vendor, extra quantity, reviewer rejections flipping the verdict;
- the no-model fallback, and a judgment that names an invalid part;
- intake validation;
- the model registry and its fallbacks;
- usage cost math;
- the streaming workaround;
- the spec library: revision-bump rules, change summaries, validation, multiple rack designs, and reviews against an edited spec;
- the 50-line test BOM against its answer key.

`npm run check` runs formatting, lint, type-check and tests. CI runs it on every pull request.

## Project structure

```
src/
  server.ts          ReviewAgent: state, callables, chat, Worker entry
  workflow.ts        ReviewWorkflow: durable steps and the approval pause
  rules.ts           all deterministic checks, severity, verdict
  llm.ts             substitution judgment and ODM note (JSON + fallbacks)
  parse.ts           CSV/JSON intake and validation
  config.ts          model registry: the only place model IDs live
  usage.ts           usage meter: cost estimates and summaries
  ai-stream-fix.ts   workaround for doubled Workers AI streaming text
  demo.ts            bundles the demo files into the Worker
  types.ts           domain types
  spec-agent.ts      SpecLibrary Durable Object: stores specs and revisions
  spec-library.ts    spec save rules, change summaries, history (pure, tested)
  spec-editor.tsx    Rack specs UI: edit, new rack, import/export, history
  app.tsx            UI: verdict, findings and approvals, note, audit log, chat
demo/                synthetic spec, BOMs, certs, build contexts
test/                vitest unit tests
wrangler.jsonc       Worker, Durable Object, Workflow and AI bindings
```

## Troubleshooting

- **`CLOUDFLARE_API_TOKEN` / "non-interactive environment" error on `npm run dev`:** run `npx wrangler login` first, or use `npm run dev:local`.
- **`EADDRINUSE ... 9229`:** another dev server is still running or shutting down. Stop it, or find it with `lsof -nP -iTCP:9229 -sTCP:LISTEN`.
- **Start from a clean slate:** stop the dev server and delete `.wrangler/state`. Local Durable Object storage (reviews, chat, usage) lives there.
- **Kimi K2.6 calls fail:** it needs the Workers Paid plan. Switch back to Llama in the dropdown.
- **Every streamed word appears twice:** this is a known `workers-ai-provider` behavior, already handled by [`src/ai-stream-fix.ts`](src/ai-stream-fix.ts). Workers AI sends each chunk's text in both `response` and `choices[0].delta.content`, and the provider emits both. If you see it, check that the wrapper is still applied in `getModel`.

## Limitations and next steps

- **One rack per review.** The spec models a single rack design. Multi-rack builds and quantity per order are not handled.
- **No authentication.** Anyone with the URL can open a review by its build ID. A real deployment would put Cloudflare Access in front.
- **Synthetic power model.** Power uses nameplate `wattsEach` from the spec and excludes unrecognized parts.
- **Note formatting.** The LLM-drafted note is accurate but tends to come out as one dense paragraph.
- **Possible stretch goals** from the [project brief](PROJECT_BRIEF.md):
  - automatically re-check open reviews when a spec changes (ECO); today a re-run picks up the new revision;
  - roles, so only some users can edit specs (the library is open to anyone with the URL);
  - a build-readiness view from lead times;
  - a Pareto chart of recurring defect types across reviews.

## Prompt history

The posting asks for AI-assisted prompt history. Every prompt used to plan and build this project is in [PROMPTS.md](PROMPTS.md), with the outcome of each. The original plan is in [PROJECT_BRIEF.md](PROJECT_BRIEF.md).
