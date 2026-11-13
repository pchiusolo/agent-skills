#!/usr/bin/env node
/**
 * validate-artifact-paths.js
 *
 * Guards the spec -> plan -> build pipeline against silent artifact-path drift.
 *
 * The `/spec` and `/plan` commands (producers) write their artifacts to a set
 * of paths that the `/build` command and the spec/plan skills (consumers) read
 * back. When a producer moves an artifact without updating the consumers — as
 * in PR #93, which pointed `/spec` and `/plan` at docs/features/[name]/ while
 * `/build` still required SPEC.md and tasks/plan.md — the pipeline breaks, and
 * nothing else in CI catches it (command parity only compares descriptions).
 *
 * This validator enforces one canonical set of spec/plan/todo artifact paths
 * across every file in the pipeline. Changing the convention means updating
 * ARTIFACT_ALLOWLIST *and* every guarded file in the same change; CI fails
 * until they agree.
 *
 * The legacy defaults are only the last resort. Under an engagement, spec,
 * plan, and task references named by the engagement win; otherwise an explicit
 * module map (CAPABILITY-MAP.md plus SPEC-<module-id>.md) selects the spec; the
 * defaults apply only when neither exists (references/autonomous-delivery-
 * contract.md). Two more checks keep that order from being lost:
 *
 *   - Every guarded command or skill that names a legacy default path must
 *     also carry the engagement-precedence rule (a reference to the contract),
 *     so no wrapper silently forces SPEC.md or tasks/ over an engagement.
 *   - Every /build consumer that names the legacy spec must also resolve the
 *     module map, so explicit per-module specs are not missed.
 *
 * Module-map artifact names are guarded like the others: CAPABILITY-MAP.md and
 * SPEC-<module-id>.md (or a concrete kebab-case id such as SPEC-billing.md) at
 * the project root are the only accepted spellings.
 *
 * Scope is deliberately narrow: only spec/plan/todo and module-map artifacts,
 * only the files that define the pipeline. It is not a general markdown path
 * linter.
 *
 * Exit codes: 0 = all clear, 1 = one or more drifted paths.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// The canonical spec/plan/todo artifact paths. These are the only artifact
// file paths the pipeline files may reference. To change the convention, edit
// this list and update every guarded file to match — CI enforces the pairing.
const ARTIFACT_ALLOWLIST = new Set([
  'SPEC.md',        // spec, project root (produced by /spec, read by /build)
  'docs/SPEC.md',   // spec, alternate location accepted by /build
  'tasks/plan.md',  // plan (produced by /plan, read by /build)
  'tasks/todo.md',  // task list (produced by /plan)
]);

// The canonical module-map artifact paths (see spec-driven-development's
// Phase 0). A concrete module id must be kebab-case.
const MODULE_ARTIFACT_RE_CANONICAL = /^(?:CAPABILITY-MAP\.md|SPEC-<module-id>\.md|SPEC-[a-z0-9]+(?:-[a-z0-9]+)*\.md)$/;

// The engagement-precedence rule, as a reference to the contract that defines it.
const PRECEDENCE_MARKER = 'autonomous-delivery-contract.md';

// The module map a /build consumer must resolve before the legacy spec.
const MODULE_MAP_MARKERS = ['CAPABILITY-MAP.md', 'SPEC-<module-id>.md'];

// The files that make up the spec -> plan -> build pipeline. Absent files are
// skipped, not failed: this validator checks path consistency, not presence.
//
// The command bodies exist once per host surface (validate-commands.js checks
// that the three sets stay in step on descriptions, but their prompt bodies
// are allowed to differ), so a producer or consumer can drift on one surface
// while the Claude Code copy stays correct. Every surface is guarded here.
const GUARDED_FILES = [
  // Claude Code commands
  '.claude/commands/spec.md',
  '.claude/commands/plan.md',
  '.claude/commands/build.md',
  // Gemini CLI commands
  '.gemini/commands/spec.toml',
  '.gemini/commands/planning.toml',
  '.gemini/commands/build.toml',
  // Root command set (Antigravity, Codex, and other TOML-based hosts)
  'commands/spec.toml',
  'commands/planning.toml',
  'commands/build.toml',
  // Skills the commands invoke
  'skills/spec-driven-development/SKILL.md',
  'skills/planning-and-task-breakdown/SKILL.md',
  // Docs that tell users where the artifacts live
  'docs/getting-started.md',
  'docs/adoption-guide.md',
  'docs/copilot-setup.md', // its prompt-file aliases name the artifacts directly
];

// Matches a path-like token ending in a spec/plan/todo artifact filename,
// including an optional directory prefix with bracket placeholders like
// docs/features/[feature-name]/spec.md. Case-insensitive so SPEC.md and a
// drifted spec.md are both caught, then compared against the allowlist. The
// lookbehind keeps the match from starting mid-word, so `test-plan.md` or
// `release_todo.md` are not mistaken for a drifted `plan.md` / `todo.md`.
const ARTIFACT_RE = /(?<![A-Za-z0-9._[\]-])(?:[A-Za-z0-9._[\]-]+\/)*(?:spec|plan|todo)\.md/gi;

// Matches a module-map artifact token in any spelling: SPEC-<id>.md and
// CAPABILITY-MAP.md, with an optional directory prefix, any case, and either
// separator, so drifted forms (docs/capability_map.md, specs/spec-x.md) are
// caught and compared against MODULE_ARTIFACT_RE_CANONICAL.
const MODULE_ARTIFACT_RE = /(?<![A-Za-z0-9._[\]<>-])(?:[A-Za-z0-9._[\]<>-]+\/)*(?:spec-[A-Za-z0-9<>[\]_-]+|capability[-_]map)\.md/gi;

// Commands and skills act on the artifacts, so they must carry the precedence
// rule; docs only describe the defaults to users.
function isActingFile(relPath) {
  return !relPath.startsWith('docs/');
}

function isBuildConsumer(relPath) {
  return /(^|\/)build\.(md|toml)$/.test(relPath);
}

function findViolations(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) return null; // skipped

  const violations = [];
  const content = fs.readFileSync(abs, 'utf8');
  const lines = content.split(/\r?\n/);
  let namesLegacySpec = false;
  let namesLegacyDefault = false;
  lines.forEach((line, i) => {
    for (const match of line.match(ARTIFACT_RE) ?? []) {
      if (!ARTIFACT_ALLOWLIST.has(match)) {
        violations.push({ line: i + 1, match, reason: 'not an approved spec/plan/todo artifact path' });
      } else {
        namesLegacyDefault = true;
        if (/SPEC\.md$/.test(match)) namesLegacySpec = true;
      }
    }
    for (const match of line.match(MODULE_ARTIFACT_RE) ?? []) {
      if (!MODULE_ARTIFACT_RE_CANONICAL.test(match)) {
        violations.push({ line: i + 1, match, reason: 'not an approved module-map artifact path (CAPABILITY-MAP.md, SPEC-<module-id>.md)' });
      }
    }
  });

  if (namesLegacyDefault && isActingFile(relPath) && !content.includes(PRECEDENCE_MARKER)) {
    violations.push({
      line: 0,
      match: 'legacy default artifact paths',
      reason: `named without the engagement-precedence rule (reference ${PRECEDENCE_MARKER})`,
    });
  }
  if (namesLegacySpec && isBuildConsumer(relPath) && !MODULE_MAP_MARKERS.every((m) => content.includes(m))) {
    violations.push({
      line: 0,
      match: 'legacy spec path',
      reason: `named without resolving the explicit module map (${MODULE_MAP_MARKERS.join(', ')})`,
    });
  }
  return violations;
}

function main() {
  console.log('Checking spec/plan/todo artifact paths...\n');

  let checked = 0;
  let errors = 0;

  for (const relPath of GUARDED_FILES) {
    const violations = findViolations(relPath);
    if (violations === null) continue; // file not present, skip
    checked++;

    if (violations.length === 0) {
      console.log(`  ✓  ${relPath}`);
    } else {
      console.log(`  ✗  ${relPath}`);
      for (const { line, match, reason } of violations) {
        console.log(`       ${line ? `L${line}` : 'file'}: ${match} — ${reason}`);
        errors++;
      }
    }
  }

  const status = errors > 0 ? 'FAILED' : 'PASSED';
  console.log(`\n${checked} files checked — ${errors} error(s) — ${status}`);

  if (errors > 0) {
    console.log('\nThe spec -> plan -> build pipeline expects one set of artifact paths.');
    console.log('Either use a path from ARTIFACT_ALLOWLIST, or change the convention');
    console.log('across every guarded file and update the allowlist in the same change.');
    console.log('Commands and skills that name the legacy defaults must also state that');
    console.log('engagement references and an explicit module map take precedence.');
    process.exit(1);
  }
}

main();
