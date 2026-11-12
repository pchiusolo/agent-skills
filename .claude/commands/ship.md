---
description: Run the pre-launch checklist via parallel fan-out to specialist personas, then synthesize a go/no-go decision
disable-model-invocation: true
---

Invoke the agent-skills:shipping-and-launch skill.

`/ship` is a **fan-out orchestrator**. It runs three specialist personas in parallel against the current change, then merges their reports into a single go/no-go decision with a rollback plan. The personas operate independently — no shared state, no ordering — which is what makes parallel execution safe and useful here.

**Under an engagement** (see `references/autonomous-delivery-contract.md`), each Phase A agent is an agent-creation request: get the Project Lead's admission (a task owner and a free slot under the contract's limits) before spawning, launch the admitted ones together, and queue the rest until slots free. Each persona still runs in its own fresh context at the exact revision under review. Without an engagement, run Phase A exactly as below.

## Phase A — Parallel fan-out

Spawn three subagents concurrently using the Agent tool. **Issue all three Agent tool calls in a single assistant turn so they execute in parallel** — sequential calls defeat the purpose of this command.

In Claude Code, each call passes `subagent_type` matching the persona's `name` field:

1. **`code-reviewer`** — Run a five-axis review (correctness, readability, architecture, security, performance) on the staged changes or recent commits. Output the standard review template.
2. **`security-auditor`** — Run a vulnerability and threat-model pass. Check OWASP Top 10, secrets handling, auth/authz, dependency CVEs. Output the standard audit report.
3. **`test-engineer`** — Analyze test coverage for the change. Identify gaps in happy path, edge cases, error paths, and concurrency scenarios. Output the standard coverage analysis.

In other harnesses without an Agent tool, you can run each persona's system prompt sequentially in this context for its checklist coverage, but a same-context pass is **not independent review**: it shares this session's context and reasoning. Label each such report "same-context pass, not independent", and either get a fresh-context review (a new session per persona, given only the change and its contract) or treat independent review as incomplete in Phase C.

Constraints (from Claude Code's subagent model):
- Subagents cannot spawn other subagents — do not let one persona delegate to another.
- Each subagent gets its own context window and returns only its report to this main session.
- If you need teammates that talk to each other instead of just reporting back, use Claude Code Agent Teams and reference these personas as teammate types (see `references/orchestration-patterns.md`).

**Persona resolution.** If you've defined your own `code-reviewer`, `security-auditor`, or `test-engineer` in `.claude/agents/` or `~/.claude/agents/`, those take precedence over this plugin's versions — `/ship` picks up your customizations automatically. This is intentional: plugin subagents sit at the bottom of Claude Code's scope priority table, so user-level definitions win by design.

## Phase B — Merge in main context

Once all three reports are back, the main agent (not a sub-persona) synthesizes them:

1. **Code Quality** — Aggregate Critical/Required findings from `code-reviewer` and any failing tests, lint, or build output. Resolve duplicates between reviewers.
2. **Security** — Promote any Critical/High `security-auditor` findings to launch blockers. Cross-reference with `code-reviewer`'s security axis.
3. **Performance** — Pull from `code-reviewer`'s performance axis; cross-check Core Web Vitals if applicable.
4. **Accessibility** — Verify keyboard nav, screen reader support, contrast (not covered by the three personas — handle directly here, or invoke the accessibility checklist).
5. **Infrastructure** — Env vars, migrations, monitoring, feature flags. Verify directly.
6. **Documentation** — README, ADRs, changelog. Verify directly.

## Phase C — Decision and rollback

Produce a single output:

```markdown
## Ship Decision: GO | NO-GO

### Blockers (must fix before ship)
- [Source persona: Critical finding + file:line]

### Recommended fixes (should fix before ship)
- [Source persona: Important finding + file:line]

### Acknowledged risks (shipping anyway)
- [Risk + mitigation]

### Rollback plan
- Trigger conditions: [what signals would prompt rollback]
- Rollback procedure: [exact steps]
- Recovery time objective: [target]

### Review independence
- [Fresh-context reports received, or "independent review incomplete: <persona> missing or same-context only"]

### Specialist reports (full)
- [code-reviewer report]
- [security-auditor report]
- [test-engineer report]
```

## Rules

1. The three Phase A personas run in parallel, each in a fresh context — never as sequential same-context passes. Under an engagement, admitted personas run together and queued ones run as slots free, still in fresh contexts.
2. Personas do not call each other. The main agent merges in Phase B.
3. The rollback plan is mandatory before any GO decision.
4. If any persona returns a Critical finding, the default verdict is NO-GO unless the user explicitly accepts the risk (under an engagement, only the owner can, as a recorded decision).
5. **Skip the fan-out only if all of the following are true:** the change touches 2 files or fewer, the diff is under 50 lines, and it does not touch auth, payments, data access, or config/env. Otherwise, default to fan-out. `/ship` is designed for production-bound changes — when the blast radius is non-trivial, run the parallel review even if the diff looks small. A skipped fan-out means no independent review ran; say so in the decision. Under an engagement this skip does not apply, because the contract's completion evidence requires a fresh-context review at the final revision.
6. Same-context passes never count as independent review. When the fan-out was required and any fresh-context report is missing, the verdict is `NO-GO: independent review incomplete` unless the user explicitly accepts the gap as an acknowledged risk. Under an engagement the gap is recorded as blocked verification; the Lead does not accept it on the owner's behalf.
7. GO is a recommendation, not a deploy. Deploying stays the user's call; under an engagement it is a reserved owner decision unless the contract authorizes it.
