#!/bin/bash
# simplify-ignore.sh — entry point for the simplify-ignore hook.
#
# Wire it to PostToolUse Read, PreToolUse Edit|Write, and Stop (see
# SIMPLIFY-IGNORE.md). The logic lives in simplify-ignore.js. The hook never
# modifies a source file or writes anywhere: it hides protected blocks by
# rewriting what the model sees (updatedToolOutput) and what Write/Edit send
# (updatedInput), and it denies edits that would change a protected block.
#
# Dependencies: node. Without it the hook does nothing (nothing is hidden,
# nothing is changed).

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' "simplify-ignore: node is required but was not found on PATH; protected blocks are not hidden and no file was changed." >&2
  exit 0
fi

exec node "$(dirname "$0")/simplify-ignore.js"
