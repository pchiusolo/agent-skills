---
description: Break work into small verifiable tasks with acceptance criteria and dependency ordering
disable-model-invocation: true
---

Invoke the `planning-and-task-breakdown` skill.

Read the spec and the relevant codebase sections. Resolve the spec in this order: the spec reference an engagement names (see `references/autonomous-delivery-contract.md`); else the module's `SPEC-<module-id>.md`, selected by id through `CAPABILITY-MAP.md`; else SPEC.md or equivalent. Then:

1. Enter plan mode — read only, no code changes
2. Identify the dependency graph between components
3. Slice work vertically (one complete path per task, not horizontal layers)
4. Write tasks with acceptance criteria and verification steps
5. Add checkpoints between phases
6. Present the plan for human review (under an engagement, record it for the owner unless a recorded owner approval or a contract clause already approves it)

Save the plan and task list to the plan and task references an engagement names; otherwise save the plan to tasks/plan.md and task list to tasks/todo.md (or the project's designated tracker).

If tasks/plan.md or tasks/todo.md already exists with unchecked tasks for different work, stop and ask before writing — never silently overwrite an incomplete plan. Under an engagement, record the conflict for the owner instead of asking; the rule against overwriting still holds.
