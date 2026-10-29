# Rack BOM Review Agent

An AI agent on Cloudflare that reviews a manufacturer's (ODM's) rack Bill of Materials against the rack spec, flags build blockers, pauses for a human to approve the findings, and then drafts the escalation note to the ODM. You can chat with it about the review ("why did you flag line 14?").

Built for the optional assignment on Cloudflare's Rack Integration Operations Engineer posting. All data in this repo is synthetic.

## Why this exists

At Qorvo I built a checklist for reviewing first article inspection packages against drawings, specs and material certs: missing dimensional results, unaddressed GD&T callouts, certs that did not match the drawing revision. At Samsung I standardized BOM governance and built vendor lead-time dashboards. Both were the same job done by hand: compare what a supplier sent against what the spec says, then chase the gaps.

This project automates that review for a data center rack, matching the posting's responsibility to "review and validate complex BOMs prior to release to integration partners, proactively identifying part substitutions, spec mismatches, and potential build blockers."

## Design principle

**Exact checks run in plain code. The LLM only does fuzzy judgment and writing.**

| Check                                                                | Done by                        |
| -------------------------------------------------------------------- | ------------------------------ |
| Revision matches spec                                                | code                           |
| Quantity per rack (summed across split lines)                        | code                           |
| Approved manufacturer                                                | code                           |
| Approved substitute used                                             | code                           |
| Cert references the current drawing revision                         | code                           |
| Lead time lands before the need-by date                              | code                           |
| Rack power within budget                                             | code                           |
| Is this off-spec part a substitute for a missing one, and how risky? | LLM (JSON, validated with zod) |
| Escalation note to the ODM                                           | LLM (JSON, validated with zod) |

If the model is unavailable or returns bad JSON, the review still completes: off-spec lines go to the reviewer as "needs review", and the note is built from a template. The app works with a weak model, or with none.

## How it maps to the assignment

| Requirement             | Implementation                                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM                     | Workers AI, Llama 3.3 70B by default. Model picker in the UI (Llama 4 Scout, Kimi K2.6, Claude Opus 5.5 if an API key is set). All IDs live in [`src/config.ts`](src/config.ts).                        |
| Workflow / coordination | A Cloudflare Workflow ([`src/workflow.ts`](src/workflow.ts)) started by the agent: intake → rules → LLM judgment → **pause for human approval** (`waitForApproval`) → draft note. Each step is durable. |
| User input via chat     | React UI with `useAgentChat`; chat answers from the review state and cites line numbers.                                                                                                                |
| Memory / state          | One `ReviewAgent` Durable Object per build ID (SQLite-backed): findings, decisions, audit log, chat history, model choice, usage.                                                                       |

## Architecture

```
Browser (React, Kumo UI)
  │  WebSocket: state sync, @callable RPC, chat stream
  ▼
ReviewAgent (AIChatAgent, Durable Object, one per build ID)
  │  runWorkflow / approveWorkflow / rejectWorkflow
  ▼
ReviewWorkflow (Cloudflare Workflow)
  intake ─► rules (code) ─► llm-judge ─► publish findings ─► waitForApproval ─► draft-note
                                │                                                  │
                                └──────────── Workers AI / Anthropic ◄─────────────┘
```

- [`src/rules.ts`](src/rules.ts): all deterministic checks, severity, verdict (any unrejected blocker → HOLD).
- [`src/llm.ts`](src/llm.ts): the two LLM calls, JSON extraction and validation, fallbacks.
- [`src/server.ts`](src/server.ts): the agent. Client state is read-only; every change goes through a method and lands in the audit log. Chat is grounded by putting the whole review (findings and BOM, about 2k tokens) in the system prompt rather than tool calls, which smaller Workers AI models handled unreliably.
- [`src/ai-stream-fix.ts`](src/ai-stream-fix.ts): Workers AI streams each chunk's text in two fields and `workers-ai-provider` emits both, doubling every word; this wrapper drops the duplicate.
- [`src/usage.ts`](src/usage.ts): usage meter. Every LLM call (judge, draft, chat) records tokens and estimated cost by model.
- [`demo/`](demo/): synthetic spec, a 39-line BOM with six planted issues, a clean BOM, certs, build contexts.

## Run it

```bash
npm install
npx wrangler login
npm run dev
```

Open http://localhost:5173, choose **Demo: 6 planted issues**, and click **Run review**. Workers AI runs remotely even in local dev, which is why it needs `wrangler login`.

No Cloudflare account? `npm run dev:local` runs everything except the LLM, which exercises the no-model fallbacks.

Tests (rule checks, model registry, usage math):

```bash
npm test
```

## Deploy

```bash
npm run deploy
```

Optional, to add Claude to the model picker:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
```

Kimi K2.6 needs the Workers Paid plan. To change the default model for new reviews, edit `DEFAULT_MODEL` in `wrangler.jsonc`.

## Demo data

The planted-issues BOM (build `BLD-2026-0412`) contains:

1. A PDU on revision C where the spec requires D (line 2).
2. A transceiver swapped for an unapproved vendor's part (line 15), which the LLM judges.
3. Power cables short by 4 (line 21).
4. A switch cert issued against an old drawing revision (line 12).
5. An SSD whose lead time lands 27 days after need-by (line 8).
6. A rack light bar that is not in the spec (line 39), which the LLM separates from the substitution.

It also includes an approved DAC substitute and power at 93% of budget, both reported as info. The clean BOM (`BLD-2026-0413`) comes back READY.

See [DEMO.md](DEMO.md) for a walkthrough.

## Prompt history

The posting asks for AI-assisted prompt history: see [PROMPTS.md](PROMPTS.md). The project plan is in [PROJECT_BRIEF.md](PROJECT_BRIEF.md).
