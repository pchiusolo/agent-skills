#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { afterEach, test } = require('node:test');

const VALIDATOR = path.join(__dirname, 'validate-artifact-paths.js');
const sandboxes = [];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-validate-artifact-paths-test-'));
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(VALIDATOR, path.join(scriptsDir, 'validate-artifact-paths.js'));
  sandboxes.push(root);
  return root;
}

function writeFile(root, relativePath, content) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function run(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'validate-artifact-paths.js')], {
    cwd: root,
    encoding: 'utf8',
  });
}

// Command and skill files that name legacy default artifact paths must also
// carry the engagement-precedence rule, and /build consumers must also resolve
// an explicit module map. These suffixes satisfy both rules in fixtures that
// test something else.
const PRECEDENCE = '\nEngagement references win; see `references/autonomous-delivery-contract.md`.\n';
const MODULE_MAP = '\nWith `CAPABILITY-MAP.md`, select `SPEC-<module-id>.md` by module id.\n';

afterEach(() => {
  for (const root of sandboxes.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('passes when producers and consumers use the canonical artifact paths', () => {
  const root = makeSandbox();
  writeFile(root, '.claude/commands/spec.md', 'Save the spec as `SPEC.md` in the project root.\n' + PRECEDENCE);
  writeFile(root, '.claude/commands/plan.md', 'Save the plan to `tasks/plan.md` and task list to `tasks/todo.md`.\n' + PRECEDENCE);
  writeFile(root, '.claude/commands/build.md', 'Look for a spec at `SPEC.md`, `docs/SPEC.md`, or under `spec/`. Require `tasks/plan.md`.\n' + PRECEDENCE + MODULE_MAP);
  writeFile(root, 'skills/spec-driven-development/SKILL.md', 'Save the plan to `tasks/plan.md` and the task list to `tasks/todo.md`.\n' + PRECEDENCE);
  writeFile(root, 'skills/planning-and-task-breakdown/SKILL.md', 'Save to `tasks/plan.md` and `tasks/todo.md`.\n' + PRECEDENCE);

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /5 files checked — 0 error\(s\) — PASSED/);
});

test('fails when a producer drifts to an unapproved artifact path (the #93 regression)', () => {
  const root = makeSandbox();
  // Only the producers are changed to the per-feature layout; consumers stay on the old paths.
  writeFile(root, '.claude/commands/spec.md', 'Save the spec to `docs/features/[feature-name]/spec.md`.\n');
  writeFile(root, '.claude/commands/plan.md', 'Save the plan to `docs/features/[feature-name]/plan.md`.\n');
  writeFile(root, '.claude/commands/build.md', 'Require a spec at `SPEC.md` and a plan at `tasks/plan.md`.\n');

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /docs\/features\/\[feature-name\]\/spec\.md/);
  assert.match(result.stdout, /docs\/features\/\[feature-name\]\/plan\.md/);
  assert.match(result.stdout, /error\(s\) — FAILED/);
});

test('reports the offending file and line number', () => {
  const root = makeSandbox();
  writeFile(root, '.claude/commands/plan.md', 'Intro line.\nSave the plan to `plan.md` in the root.\n');

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /\.claude\/commands\/plan\.md/);
  assert.match(result.stdout, /L2:/);
});

test('accepts the docs/SPEC.md alternate spec location', () => {
  const root = makeSandbox();
  writeFile(root, '.claude/commands/build.md', 'Look for the spec at `docs/SPEC.md`.\n' + PRECEDENCE + MODULE_MAP);

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 files checked — 0 error\(s\) — PASSED/);
});

test('ignores non-artifact markdown references (no false positives)', () => {
  const root = makeSandbox();
  writeFile(
    root,
    'skills/spec-driven-development/SKILL.md',
    'See `SKILL.md` and `references/testing-patterns.md`. Save the plan to `tasks/plan.md`.\n' + PRECEDENCE,
  );

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 files checked — 0 error\(s\) — PASSED/);
});

test('does not mistake the tail of an unrelated filename for an artifact path', () => {
  const root = makeSandbox();
  writeFile(
    root,
    'skills/planning-and-task-breakdown/SKILL.md',
    'Attach `test-plan.md` and `release_todo.md`. Save the plan to `tasks/plan.md`.\n' + PRECEDENCE,
  );

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 files checked — 0 error\(s\) — PASSED/);
});

test('skips guarded files that do not exist', () => {
  const root = makeSandbox();
  writeFile(root, '.claude/commands/spec.md', 'Save the spec as `SPEC.md`.\n' + PRECEDENCE);
  // No other guarded files present.

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 files checked — 0 error\(s\) — PASSED/);
});

// ─── Every command surface is guarded, not only the Claude Code copy ────────
//
// The Gemini and root TOML command sets carry their own prompt bodies, which
// validate-commands.js deliberately does not compare. A producer can therefore
// drift on one surface while `.claude/commands/` stays correct, and before
// these files were guarded that drift merged silently.

test('fails when a Gemini command drifts while the Claude Code copy stays canonical', () => {
  const root = makeSandbox();
  writeFile(root, '.claude/commands/spec.md', 'Save the spec as `SPEC.md` in the project root.\n' + PRECEDENCE);
  writeFile(
    root,
    '.gemini/commands/spec.toml',
    'description = "Start spec-driven development"\n\nprompt = """\nSave the spec to `docs/features/[feature-name]/spec.md`.\n"""\n',
  );

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /\.gemini\/commands\/spec\.toml/);
  assert.match(result.stdout, /L4: docs\/features\/\[feature-name\]\/spec\.md/);
  assert.match(result.stdout, /1 error\(s\) — FAILED/);
});

test('fails when a root TOML consumer drifts away from the producers', () => {
  const root = makeSandbox();
  writeFile(root, 'commands/planning.toml', 'prompt = """\nSave the plan to `tasks/plan.md` and the task list to `tasks/todo.md`.\n"""\n');
  writeFile(root, 'commands/build.toml', 'prompt = """\nRead the plan from `planning/plan.md` before starting.\n"""\n');

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /commands\/build\.toml/);
  assert.match(result.stdout, /planning\/plan\.md/);
});

test('passes when all three command surfaces agree on the canonical paths', () => {
  const root = makeSandbox();
  for (const dir of ['.claude/commands', '.gemini/commands', 'commands']) {
    const ext = dir === '.claude/commands' ? 'md' : 'toml';
    const planStem = dir === '.claude/commands' ? 'plan' : 'planning';
    writeFile(root, `${dir}/spec.${ext}`, 'Save the spec as `SPEC.md`.\n' + PRECEDENCE);
    writeFile(root, `${dir}/${planStem}.${ext}`, 'Save to `tasks/plan.md` and `tasks/todo.md`.\n' + PRECEDENCE);
    writeFile(root, `${dir}/build.${ext}`, 'Require `SPEC.md` or `docs/SPEC.md`, and `tasks/plan.md`.\n' + PRECEDENCE + MODULE_MAP);
  }

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /9 files checked — 0 error\(s\) — PASSED/);
});

test('guards the Copilot setup doc, whose prompt-file aliases name the artifacts', () => {
  const root = makeSandbox();
  writeFile(root, 'docs/copilot-setup.md', 'Read `tasks/plan.md`, then write the spec to `specs/[name]/spec.md`.\n');

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /docs\/copilot-setup\.md/);
  assert.match(result.stdout, /specs\/\[name\]\/spec\.md/);
});

// ─── Engagement precedence and explicit module maps ─────────────────────────
//
// Under an engagement, spec/plan/task references named by the engagement win;
// otherwise an explicit module map selects the spec; the legacy defaults apply
// only when neither exists. A wrapper that forces SPEC.md or tasks/plan.md
// without saying so silently overrides the engagement, and a /build that only
// looks for SPEC.md misses the per-module specs spec-driven-development writes.

test('fails when a command names legacy default paths without the engagement-precedence rule', () => {
  const root = makeSandbox();
  writeFile(root, '.claude/commands/plan.md', 'Save the plan to `tasks/plan.md` and task list to `tasks/todo.md`.\n');

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /\.claude\/commands\/plan\.md/);
  assert.match(result.stdout, /engagement-precedence/);
  assert.match(result.stdout, /1 error\(s\) — FAILED/);
});

test('does not require the engagement-precedence rule in user-facing docs', () => {
  const root = makeSandbox();
  writeFile(root, 'docs/getting-started.md', 'The spec lands in `SPEC.md` and the plan in `tasks/plan.md`.\n');

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 files checked — 0 error\(s\) — PASSED/);
});

test('fails when a /build consumer names the legacy spec but cannot resolve a module map', () => {
  const root = makeSandbox();
  writeFile(root, 'commands/build.toml', 'prompt = """\nRequire `SPEC.md` and `tasks/plan.md`.\n"""\n' + PRECEDENCE);

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /commands\/build\.toml/);
  assert.match(result.stdout, /module map/);
  assert.match(result.stdout, /1 error\(s\) — FAILED/);
});

test('accepts the canonical module-map artifacts', () => {
  const root = makeSandbox();
  writeFile(
    root,
    'skills/spec-driven-development/SKILL.md',
    'Save the map as `CAPABILITY-MAP.md` and each module spec as `SPEC-<module-id>.md` (`SPEC-identity.md`, `SPEC-billing.md`).\n' + PRECEDENCE,
  );

  const result = run(root);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /1 files checked — 0 error\(s\) — PASSED/);
});

test('fails when a module-map artifact drifts from the canonical names', () => {
  const root = makeSandbox();
  writeFile(
    root,
    'skills/spec-driven-development/SKILL.md',
    'Save the map as `docs/capability_map.md` and module specs as `specs/spec-identity.md`.\n' + PRECEDENCE,
  );

  const result = run(root);

  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /docs\/capability_map\.md/);
  assert.match(result.stdout, /specs\/spec-identity\.md/);
});
