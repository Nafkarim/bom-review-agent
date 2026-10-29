# Prompt History

This file records the prompts used to plan and build this project, as the Cloudflare posting requires ("AI-assisted coding is encouraged, but you have to submit prompt history").

**Rules for keeping it:**

- Prompts are logged verbatim (typos included), in order.
- Add each new prompt before acting on it, and fill in the one-line outcome afterward.
- Planning-phase entries below come from a claude.ai chat session with Claude (Sonnet 5.5). Later entries come from Claude Code.
- Earlier resume-tailoring prompts (in a separate chat) are not part of this project and are not logged here.

---

## Phase 1: Planning (claude.ai chat)

### 1. 2026-10-26
**Prompt:**
> do you have contect of the job app im doing

**Outcome:** Claude did not have the job posting in that chat and asked for the role.

### 2. 2026-10-26
**Prompt:**
> its in another chat under this project folder named cloudflare resume tailoring

**Outcome:** Claude searched past chats and found the Cloudflare role (Rack Integration Operations Engineer) and the optional fast-track assignment.

### 3. 2026-10-26
**Prompt:**
> so you have context of what this role is correct

**Outcome:** Claude summarized the role and its requirements.

### 4. 2026-10-26
**Prompt:**
> this chat is for building the optional assignment

**Outcome:** Claude listed the four required components and proposed a hardware-ops app idea.

### 5. 2026-10-26
**Prompt:**
> https://developers.cloudflare.com/agents/

**Outcome:** Claude read the Cloudflare Agents docs (overview, quick start, chat agent example) and mapped them to the four requirements.

### 6. 2026-10-26
**Prompt:**
> why is llama reccomended

**Outcome:** Claude explained likely reasons (platform-native, no API key) and flagged them as inference.

### 7. 2026-10-26
**Prompt:**
> could you run opus or sonnet?

**Outcome:** Claude explained external models are possible via an API key and proposed a model config switch.

### 8. 2026-10-26
**Prompt:**
> what about gemini 4

**Outcome:** Claude searched; found third-party sources describing Gemini 4 Argon, noted source conflicts, and recommended verifying the model ID with Google.

### 9. 2026-10-26
**Prompt:**
> i dont understand why they would reccomend this model. is not outdated compared to others

**Outcome:** Claude agreed the recommendation looks like a stale default and proposed using the newest Workers AI model that handles tool calling.

### 10. 2026-10-26
**Prompt:**
> what is workers ai

**Outcome:** Claude explained Workers AI.

### 11. 2026-10-28
**Prompt:**
> give a rundown on what the criteria is for this agent they want me to build

**Outcome:** Claude re-read the posting and listed the exact criteria; corrected earlier claims (an external LLM is allowed, and submission is a GitHub repo URL).

### 12. 2026-10-28
**Prompt:**
> give me some ideas on things to build

**Outcome:** Claude proposed six app ideas and recommended a BOM review copilot.

### 13. 2026-10-28
**Prompt:**
> what is sometjhing that stretches back to my projects and expeirances that can also be applicable for this orle

**Outcome:** Claude read the resume and proposed automating the Qorvo first-article-inspection checklist as a BOM/spec review agent.

### 14. 2026-10-28
**Prompt:**
> lets go with this, help me make a plan of what information it takes in, what it does, and what it spits out

**Outcome:** Claude produced the inputs / pipeline / outputs plan, with exact checks in code and the LLM for fuzzy judgment only.

### 15. 2026-10-28
**Prompt:**
> ok i want to move to claude code, create an md file of what we are building (this ncludes the bom agent but also things about criteria for the assignment), I’d also start a `PROMPTS.md` now and log every prompt, since the posting requires prompt history. do this as well. create a file name it cloudflare_assignment for everything to be stored in

**Outcome:** Claude created the `cloudflare_assignment` folder with `PROJECT_BRIEF.md`, `PROMPTS.md`, and `CLAUDE.md`.

### 16. 2026-10-28
**Prompt:**
> moving to claude code now

**Outcome:** Claude confirmed the folder is ready; planning phase ends here.

---

## Phase 2: Build (Claude Code)

<!-- Append new entries below. Format:

### N. YYYY-MM-DD
**Prompt:**
> exact prompt text

**Outcome:** one line on what happened.
-->

### 17. 2026-10-28
**Prompt:**
> Plan how we build this

**Outcome:** Claude read the brief and the Agents Workflows docs, checked the Workers AI catalog and agents-starter, asked about model and workflow choices, and wrote a phased build plan (AgentWorkflow with `waitForApproval` for the approval gate).

### 18. 2026-10-28
**Prompt:**
> between llama and claude via secret what is best?

**Outcome:** Claude recommended Llama 3.3 on Workers AI as the default (free plan, no key, posting-recommended) with Claude as an optional switch via a Wrangler secret.

### 19. 2026-10-28
**Prompt:**
> put default model as llama, but have the capibility for useres to change llm/model.

**Outcome:** Plan updated: a model registry in `src/config.ts`, a model dropdown in the UI, the selection stored in agent state, Llama 3.3 as default.

### 20. 2026-10-28
**Prompt:**
> add a usage meter

**Outcome:** Plan updated with a usage meter and approved; Claude then built the MVP (rules + tests, LLM judge/note with fallbacks, AgentWorkflow approval gate, model picker, usage meter, chat, UI, README, demo script) and verified the no-LLM path end to end in the browser; LLM paths await `wrangler login`.

### 21. 2026-10-28
**Prompt:**
> create a github repo for this project and make a PR

**Outcome:** Claude created the public repo Nafkarim/bom-review-agent (planning docs on `main`) and opened PR #1 with the MVP build from `feat/bom-review-mvp`.

### 22. 2026-10-28
**Prompt:**
> Turn on Auto-fix for PR #1.

**Outcome:** Claude enabled Auto-fix on PR #1, so CI failures, merge conflicts and review comments wake the session to fix them.
