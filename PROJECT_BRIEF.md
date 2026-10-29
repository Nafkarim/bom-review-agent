# Cloudflare Optional Assignment: Rack BOM Review Agent

Last updated: 2026-10-28

## 1. Context

- **Role:** Rack Integration Operations Engineer, Cloudflare (Infrastructure Engineering / Hardware Integration, with the Strategy team). Hybrid. Austin range is $116K-$128K.
- **Posting:** https://job-boards.greenhouse.io/cloudflare/jobs/8267826?gh_jid=8267826&gh_src=5ylsd31
- **Goal of this project:** complete the posting's optional assignment so the application may be fast-tracked, and make the project a strong resume line for this role.
- **Resume used for the application:** `nafkarim_cloudflare.pdf` (tailored from the data center resume).

## 2. Assignment criteria (from the posting)

Quoted/paraphrased from the "Optional Assignment" field on the application form:

> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare.

An AI-powered application should include:

1. **LLM.** Llama 3.3 on Workers AI is recommended, **or an external LLM of your choice**.
2. **Workflow / coordination.** Recommended: Workflows, Workers, or Durable Objects.
3. **User input via chat or voice.** Recommended: Pages or Realtime.
4. **Memory or state.**

Other rules:

- **AI-assisted coding is encouraged, but prompt history must be submitted.** (Hence `PROMPTS.md`.)
- **Submission:** the application form asks for a **GitHub repo URL** for the project.
- Documentation links from the posting: https://agents.cloudflare.com/ and https://developers.cloudflare.com/agents/

**Not specified by the posting (ask the recruiter):**

- A deadline.
- How the work is evaluated.
- What "fast track" means in practice.
- The format or location for prompt history (committing it to the repo is the plan).

**Does the app have to be about hardware?** No. It only needs the four components. We chose a hardware-ops app because it doubles as proof for this role.

**Culture signals in the posting (inference, not stated criteria):** it emphasizes builders who spot a "normalized" problem and use AI to fix it, shipping iteratively, and sharing lightweight tooling with the team. A clean README, working code, and clear prompt history probably matter more than model choice.

## 3. What we are building

**A BOM and spec review agent.** It reviews a manufacturer's submitted Bill of Materials against a rack spec, flags problems, waits for a human to approve the findings, and drafts the escalation note to the manufacturer.

**Origin story (use in the README):** at Qorvo I built a checklist for reviewing first article inspection packages against drawings, specs, and material certs, flagging missing dimensional results, unaddressed GD&T callouts, and certs that did not match the drawing revision. At Samsung I standardized BOM governance and built vendor lead-time dashboards. This project automates that review with an AI agent. It maps directly to the posting's responsibility: "Review and validate complex BOMs prior to release to integration partners, proactively identifying part substitutions, spec mismatches, and potential build blockers."

### Design principle

**Exact checks run in plain code. The LLM only handles fuzzy judgment and writing.** Llama can be unreliable at arithmetic and exact matching, and code never is. The app should still work if the model gives a weak answer.

## 4. Inputs (all synthetic data)

| Input | What it is |
|---|---|
| Spec | Reference for one rack design: required parts (part number, revision, quantity per rack), approved-vendor list with allowed substitutes, rack power budget, required firmware version |
| Submitted BOM | CSV from the "ODM": line, part number, description, manufacturer, quantity, revision, lead time, cert reference |
| Build context | Build ID, ODM name, spec revision, need-by date |
| Cert list | Small CSV pairing each cert with the drawing/spec revision it references (stands in for the FAI package) |
| Chat messages | e.g. "why did you flag line 14?", "what is blocking this build?" |

## 5. Processing pipeline

1. **Intake.** Validate that the files are well formed. Create one agent instance for this review (holds all state).
2. **Rule checks (code, no LLM):**
   - Part missing from the spec, or not on the approved list.
   - Quantity wrong.
   - Revision does not match the spec.
   - Cert references an old revision.
   - Lead time misses the need-by date.
   - Total power draw exceeds the rack budget.
3. **LLM judgment (only on lines the rules cannot settle).** Example: a different manufacturer and description, so is it a real substitution and how risky? The model returns structured JSON, not free text.
4. **Severity.** Each finding is a Blocker, Needs review, or Info.
5. **Approval gate.** The workflow pauses so a human can approve, reject, or edit findings (`needsApproval`).
6. **Draft the escalation note** to the ODM, covering approved findings only.
7. **Chat** answers questions about the review and cites line numbers.

## 6. Outputs

- **Review report:** overall verdict (Ready / Hold), counts by severity, findings table.
- **Draft ODM escalation note,** released only after approval.
- **Persistent review state,** including an audit log of what was approved and when.
- **Chat answers** that point back to specific lines.

Finding shape (draft):

```json
{
  "line": 14,
  "partNumber": "XCVR-100G-A",
  "category": "substitution | missing-data | revision-mismatch | quantity | lead-time | power | cert | not-in-spec",
  "severity": "blocker | needs-review | info",
  "expected": "...",
  "found": "...",
  "evidence": "...",
  "suggestedAction": "...",
  "source": "rule | llm"
}
```

## 7. Demo data

Build a roughly 40-line synthetic BOM with six planted issues:

1. A PDU on the wrong revision.
2. A transceiver substituted from another vendor.
3. A power-cable quantity shortfall.
4. A cert tied to an old drawing revision.
5. A part whose lead time is past the need-by date.
6. A part that is not in the spec.

Also keep a clean BOM so the "Ready" path can be demoed.

## 8. Mapping to the posting's requirements

| Requirement | Where it is covered |
|---|---|
| LLM | Workers AI for substitution judgment and drafting; model is a single config value |
| Workflow / coordination | Review workflow with an approval pause (Agents SDK / Workflows) |
| Chat input | React chat UI using the Agents SDK (`AIChatAgent`, `useAgentChat`) |
| Memory / state | One agent instance per review, persisted in SQLite via Durable Objects |

## 9. Tech notes (from the Cloudflare Agents docs, read 2026-10-28)

- **Starter:** `npm create cloudflare@latest -- --template cloudflare/agents-starter` (gives `src/server.ts`, `src/client.tsx`, `wrangler.jsonc`, `tsconfig.json`, `vite.config.ts`).
- **Chat example deps:** `agents @cloudflare/ai-chat ai @ai-sdk/provider zod`.
- **Wrangler config needs:** `"ai": { "binding": "AI" }`, a Durable Object binding per agent class, a migration with `new_sqlite_classes`, `compatibility_flags: ["nodejs_compat"]`, and `compatibility_date` set to a current date.
- **Server:** extend `AIChatAgent`; `onChatMessage()` uses `streamText` with tools; tools can have `needsApproval` for human-in-the-loop. State uses `this.setState()`; mark client-callable methods with `@callable()`.
- **Decorators:** do NOT set `experimentalDecorators` in tsconfig (the SDK uses TC39 decorators). Use `"target": "ES2021"`.
- **Routing:** return the `routeAgentRequest` response unchanged or WebSockets break.
- **Workflows from an agent:** docs page "Run Workflows": https://developers.cloudflare.com/agents/runtime/execution/run-workflows/ (not read yet; read before writing the workflow).
- **Types and dev:** `npx wrangler types`, `npm run dev`. Deploy: `npx wrangler deploy` (the user runs `wrangler login` and deploy; the AI workspace cannot reach their Cloudflare account).

### Model decision

- Default to a Workers AI model (no API key needed, so a reviewer can deploy it as-is).
- The posting recommends Llama 3.3 but explicitly allows an external LLM. The current Agents docs example uses `@cf/meta/llama-4-scout-17b-16e-instruct`.
- **To do before hardcoding:** check the Workers AI model catalog for the best current model that supports tool calling and structured output.
- Keep the model ID in one config value. If tool calling is flaky, an external model (Claude via `@ai-sdk/anthropic`, or Gemini) can be swapped in with a Wrangler secret. Verify any external model ID against the provider's own docs first.

## 10. Scope

- **MVP:** everything in sections 4-6, one review at a time, clean demo flow.
- **Stretch:**
  - A spec revision change (ECO) re-checks open reviews and shows which are affected.
  - Build readiness view using lead times (from the Samsung lead-time work).
  - Summary of recurring defect types across reviews (from the Samsung Pareto/8D work).

## 11. Ground rules

- **Synthetic data only.** Do not use Samsung or Qorvo documents, checklists, part numbers, or specs. Describing the concept is fine. The repo will be public.
- **No secrets in the repo.** API keys go in Wrangler secrets.
- **Log every prompt** in `PROMPTS.md` (see `CLAUDE.md`).
- **Keep it small and polished** rather than sprawling.
- Exact checks in code; LLM for fuzzy judgment and writing only.

## 12. Build plan

1. Scaffold from `agents-starter`; confirm it runs locally.
2. Define types, the spec/BOM/cert formats, and the synthetic demo data.
3. Write the deterministic rule checks with tests.
4. Add the LLM judgment step with structured output.
5. Build the review workflow with the approval pause.
6. Wire chat and tools; build the UI (findings table, approval buttons, chat).
7. Draft the escalation note step.
8. README (architecture, origin story, how to run and deploy), demo script, and final `PROMPTS.md`.
9. Deploy (user runs `wrangler login` and `wrangler deploy`), then submit the repo URL in the application.

## 13. Deliverables checklist

- [ ] Public GitHub repo
- [ ] README with architecture, origin story, and run/deploy steps
- [ ] `PROMPTS.md` complete
- [ ] Demo data and demo script
- [ ] Tests for the rule checks
- [ ] (Optional) deployed URL
- [ ] Repo URL entered in the application's optional assignment field

## 14. Open questions

- Ask the recruiter: deadline, evaluation criteria, what fast-track means, and the preferred format for prompt history.
- Which Workers AI model to use (catalog check pending).
- Exact Workflows integration pattern (docs page pending).

## 15. Sources

- Job posting: https://job-boards.greenhouse.io/cloudflare/jobs/8267826?gh_jid=8267826&gh_src=5ylsd31
- https://developers.cloudflare.com/agents/
- https://developers.cloudflare.com/agents/getting-started/quick-start/
- https://developers.cloudflare.com/agents/examples/chat-agent/
