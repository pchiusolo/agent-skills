# Definition of Done

A standing, project-wide bar that every change must clear before it counts as done. Unlike acceptance criteria, which vary per task and answer "did we build the right thing?", the Definition of Done is the same every time and answers "is this finished to our standard?". Use it as the final gate in `planning-and-task-breakdown`, `incremental-implementation`, and `shipping-and-launch`.

## Definition of Done vs. Acceptance Criteria

| | Acceptance Criteria | Definition of Done |
|---|---|---|
| Scope | Specific to one task or spec | Applies to every increment |
| Changes | Different for each item | Fixed and reused |
| Answers | "Did we build *this thing*?" | "Is it *ready*?" |
| Owner | Defined when planning the task | Defined once for the project |
| Example | "User can reset password via email link" | "Tests pass, no regressions, docs updated" |

The two are complementary. A task is done only when **its** acceptance criteria are met **and** the standing Definition of Done is satisfied. Skipping either leaves work that looks finished but is not.

## The Standing Checklist

Apply this to every change before declaring it done.

### Correctness
- [ ] All acceptance criteria for the task are met
- [ ] Code runs and behaves as intended, verified at runtime, not just compiled or typechecked
- [ ] New behavior is covered by tests that fail without the change and pass with it
- [ ] Existing tests still pass; no regressions introduced
- [ ] Edge cases and error paths are handled, not just the happy path

### Quality
- [ ] Code reveals intent through naming and structure; no comments needed to explain *what* it does
- [ ] No duplicated business logic
- [ ] No dead code, debug output, or commented-out blocks left behind
- [ ] Changes are scoped to the task; no unrelated refactors snuck in
- [ ] Linting and formatting pass

The depth behind these items lives in `code-review-and-quality` (the five-axis review) and `code-simplification` (reducing complexity without changing behavior).

### Integration
- [ ] Change works with the rest of the system, not just in isolation
- [ ] Database migrations, config changes, and feature flags are accounted for
- [ ] Backward compatibility considered for any public interface or API change

### Documentation
- [ ] Public interfaces, APIs, and user-facing behavior are documented
- [ ] Architectural decisions worth preserving are recorded (see `documentation-and-adrs`)
- [ ] Documentation describes the current state in timeless language, not the change history

### Ship-readiness
- [ ] Security implications reviewed for any untrusted input, auth, or data handling (see `security-and-hardening`)
- [ ] Observability in place for new critical paths (logs, metrics, traces) (see `observability-and-instrumentation`)
- [ ] Rollback path exists for anything risky (see `shipping-and-launch`)
- [ ] The human has reviewed and approved before merge or deploy (under an engagement, merge and deploy stay reserved owner decisions unless the contract explicitly authorizes them; see [autonomous-delivery-contract.md](autonomous-delivery-contract.md))

## Evidence at the Final Revision

A claim of done is a claim about one exact revision. Before work counts as complete, record against the final revision (the commit SHA being delivered):

- [ ] Every acceptance criterion checked against that revision
- [ ] The test commands run at that revision, with their output
- [ ] A fresh, independent review at that same revision: a reviewer in a new context that receives the artifact and its contract, not the author's reasoning. Same-context sequential persona passes, self-questioning, and the author re-reading its own work do not count. If no fresh-context reviewer is available, verification is incomplete; say so rather than reporting it as passed
- [ ] Every review finding reconciled against the code and tests: fixed, accepted as a documented trade-off, or shown to be noise

**A head change invalidates the affected claims.** A new commit, amend, rebase, or base merge moves the revision; test results and review findings tied to the old revision no longer cover the files it changed. Re-run the affected tests and review the change at the new head before claiming done again.

## How to Apply

- **Per task**: confirm the Correctness and Quality sections before checking the task off.
- **Per feature**: confirm Integration and Documentation before considering the feature complete.
- **Per release**: the full checklist is the floor; `shipping-and-launch` adds the deploy-specific gates on top.
- **Per delivery** (a pull request, a release candidate, or an engagement outcome): record the Evidence at the Final Revision before calling it complete.

Tailor the list to the project once, then reuse it unchanged. A Definition of Done that is renegotiated every sprint is not a Definition of Done.

## Red Flags

- "It's done, I just haven't run it yet": unverified work is not done.
- "Tests pass" used as a synonym for done while docs, regressions, or runtime verification are skipped.
- A different bar applied depending on deadline pressure.
- Acceptance criteria treated as the whole bar, with no standing quality floor.
- "Done" declared before human review on changes that need it.
- Test output or a review from an earlier commit cited as evidence for a later head.
- A same-context self-review reported as independent review.
