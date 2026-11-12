---
description: Implement tasks incrementally — build, test, verify, commit. Add "auto" to run the whole plan in one approved pass.
disable-model-invocation: true
---

Invoke the agent-skills:incremental-implementation skill alongside agent-skills:test-driven-development.

## Modes

- **`/build`** — implement the *next* pending task, then stop (careful, one slice at a time).
- **`/build auto`** — generate the plan if needed, get a single approval, then implement *every* task without stopping between them.

`$ARGUMENTS` selects the mode. Treat `auto` (canonical) or `all` as autonomous mode; anything else (or empty) is the default single-task mode. Note: autonomous mode is not faster *per task* — it runs the same test-driven loop — it only removes the human stepping *between* tasks.

## Under an engagement

If this run is under an engagement (see `references/autonomous-delivery-contract.md`), every "ask", "wait", and "stop and ask the user" below means: check the durable engagement record first; proceed when the contract or a recorded owner answer already covers the decision, and cite it; otherwise record the open question for the owner and block that task (continue other authorized tasks), never inventing an answer. High-risk or irreversible actions stay reserved owner decisions unless the contract names that exact action, and the doubt-driven safety checks and host permission prompts still apply. Without an engagement, everything below applies exactly as written.

## Resolve the artifacts

Resolve the spec, plan, and task list in this order, and use the first that exists:

1. **Engagement references.** Under an engagement, the spec, plan, and task references (or tracker) the engagement names.
2. **Explicit module map.** `CAPABILITY-MAP.md` at the repo root: select the module by an id given in the arguments (e.g. `/build billing` or `/build auto billing`; a module id is not a mode), or the next unfinished module in the map's build order, and use that module's `SPEC-<module-id>.md`.
3. **Legacy defaults.** `SPEC.md` at the repo root, `docs/SPEC.md`, or a file under `spec/`; the plan in `tasks/plan.md` and tasks in `tasks/todo.md` (or the project's designated tracker).

A README or arbitrary doc does **not** count as a spec.

## Default: one task

Pick the next pending task from the plan. Then:

1. Read the task's acceptance criteria
2. Load relevant context (existing code, patterns, types)
3. Write a failing test for the expected behavior (RED)
4. Implement the minimum code to pass the test (GREEN)
5. Run the full test suite to check for regressions
6. Run the build to verify compilation
7. Commit with a descriptive message
8. Mark the task complete and stop

## Autonomous: the whole plan (`/build auto`)

Use this once a spec exists and you want to collapse plan + build into one run. It removes the manual stepping between tasks — **not** the verification. Every task still earns a passing test and its own commit.

1. **Require a spec.** Resolve it as in "Resolve the artifacts" above. If none exists, stop and tell the user to run `/spec` first — do not invent requirements.
2. **Establish a clean baseline.** Run `git status --porcelain`. If there are uncommitted changes outside the expected planning artifacts (the resolved spec, plan, and task files: engagement paths, `CAPABILITY-MAP.md` and `SPEC-<module-id>.md`, or `SPEC.md`, `docs/SPEC.md`, `spec/*`, `tasks/plan.md`, `tasks/todo.md`), stop and ask the user to commit, stash, or confirm how to handle them. Autonomous per-task commits must not absorb unrelated local work, or the clean-rollback guarantee breaks.
3. **Plan if needed.** If no plan resolves, invoke agent-skills:planning-and-task-breakdown to generate one.
4. **Single checkpoint.** Present the full plan and wait for an unambiguous affirmative (e.g. "approve", "go", "yes"). Treat hedged responses ("looks reasonable", "I guess") as **not** approved. This is the only human gate — after approval, run autonomously. Under an engagement, only a recorded owner approval of this plan, or a contract clause that authorizes executing it, passes this gate; otherwise record the plan for the owner and stop. If you generated the plan file, commit it as a single preparatory commit now so it doesn't bleed into the first task's commit.
5. **Execute every task in dependency order.** Use each task's declared dependencies; if they aren't explicit, execute in the order the plan lists them. For each task, run the full default loop above (RED → GREEN → regression → build → commit → mark complete). Stage only the files that task touched plus its task-status update — never `git add -A` blindly — and make one commit per task so any point is a clean rollback.
6. **Stop and ask the user** (do not push through) when:
   - a test can't be made to pass or the build breaks without an obvious fix → follow agent-skills:debugging-and-error-recovery
   - the spec is ambiguous, or a task needs a decision the spec doesn't cover
   - a task is high-risk or irreversible — auth/permission changes, destructive data migrations, payments, deletions, deploys, anything touching secrets, **or anything you can't undo with `git revert`** → follow agent-skills:doubt-driven-development and get explicit sign-off before continuing

   After the user resolves a blocker, they re-invoke `/build auto` — it resumes from the next pending task.
7. **Summarize at the end:** tasks completed, tests added, commits made, and anything skipped, flagged, or left for the user.

If any step fails, follow the agent-skills:debugging-and-error-recovery skill.
