# Instructions for Claude Code

This folder holds the Cloudflare optional-assignment project: a BOM and spec review agent built on the Cloudflare Agents SDK. Read `PROJECT_BRIEF.md` first; it is the source of truth for scope, criteria, design, and ground rules.

## Prompt logging (required by the job posting)

- Before acting on each user prompt, append it **verbatim** to `PROMPTS.md` under "Phase 2: Build", numbered continuing from the last entry, with today's date.
- After finishing the work for that prompt, add a one-line **Outcome**.
- Never edit or remove earlier entries.

## Ground rules

- Use **synthetic data only**. No Samsung or Qorvo documents, part numbers, or specs.
- Never commit secrets. API keys go in Wrangler secrets.
- Exact checks (revision, quantity, lead time, power, approved-vendor) run in **plain code**. The LLM is only for fuzzy judgment (substitutions) and writing (escalation notes), and must return structured output.
- Keep the model ID in one config value. Default to a Workers AI model; verify the Workers AI catalog for tool-calling support before hardcoding.
- Do not set `experimentalDecorators` in tsconfig (the Agents SDK uses TC39 decorators). Use `"target": "ES2021"`.
- Return `routeAgentRequest` responses unchanged, or WebSockets break.
- Check the current Cloudflare Agents docs before using an API (https://developers.cloudflare.com/agents/). The Workflows page (`/agents/runtime/execution/run-workflows/`) has not been read yet.
- Keep scope small and polished: MVP first, stretch goals only if time allows.
- The user runs `wrangler login` and `wrangler deploy` themselves.
