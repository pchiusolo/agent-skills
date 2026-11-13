# simplify-ignore hook

Block-level protection for `/code-simplify`. Mark code that should never be simplified — the model sees a placeholder instead, and edits that would change the block are refused. **The file on disk is never modified by the hook.**

## Opt-in only

This hook is not registered by the plugin and is never installed automatically: you add it to your own `.claude/settings.json`. It writes nothing anywhere: no cache, no backup, no temporary copy of your file. Under an autonomous engagement ([references/autonomous-delivery-contract.md](../references/autonomous-delivery-contract.md)) it stays off unless the contract enables it. The same applies to the optional [sdd-cache](SDD-CACHE.md) and session-start hooks.

## Setup

1. Annotate blocks you want to protect:

```js
/* simplify-ignore-start: perf-critical */
// manually unrolled XOR — 3x faster than a loop
result[0] = buf[0] ^ key[0];
result[1] = buf[1] ^ key[1];
result[2] = buf[2] ^ key[2];
result[3] = buf[3] ^ key[3];
/* simplify-ignore-end */
```

2. Add hooks to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Read",
        "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/hooks/simplify-ignore.sh\"" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PROJECT_DIR}/hooks/simplify-ignore.sh\"" }]
      }
    ]
  }
}
```

3. Run `/code-simplify` — protected blocks appear as `/* BLOCK_de115a1d: perf-critical */` placeholders. The model reasons about surrounding code without seeing the protected implementation.

## How it works

One script, one decision per event. Every phase re-reads the real file and recomputes the blocks from it; nothing is stored between calls.

| Event | Action |
|---|---|
| `PostToolUse Read` | Replaces the Read result the model sees with a filtered view (`hookSpecificOutput.updatedToolOutput`): each block becomes one `BLOCK_<hash>` placeholder line, and a note explains the placeholders. The Read itself already ran on the real file |
| `PreToolUse Write` | Expands each placeholder in the new content back into the real block (`hookSpecificOutput.updatedInput`), so the Write tool writes real code. Denies a Write that would drop a protected block, or that carries placeholders from another file |
| `PreToolUse Edit` | Simulates the edit on the real file and denies it if it would change a protected block (for example a `replace_all` that reaches into one). Expands placeholders in `new_string` |
| `Stop` (optional) | Nothing to restore. Only reports files left by the old in-place version of this hook |

Each block is content-hashed (first 8 hex chars of SHA-1), so the round-trip is unambiguous even if the model duplicates or reorders placeholders. Placeholders preserve the original comment syntax (`# BLOCK_xxx` for Python, `<!-- BLOCK_xxx -->` for HTML). The hook returns no permission decision when it rewrites input, so your permission rules and prompts apply to the rewritten call as usual.

Verified against Claude Code 2.1.322: `updatedToolOutput` replaces a built-in Read result, `updatedInput` rewrites a Write's content, and Edit's "string to replace not found" check runs *before* PreToolUse hooks. That last fact is why an Edit cannot target a placeholder line (see limitations).

## Annotation syntax

```js
/* simplify-ignore-start */           // basic — hides the block
/* simplify-ignore-start: reason */   // with reason — appears in placeholder
/* simplify-ignore-end */
```

Any comment style works (`//`, `/*`, `#`, `<!--`). Multiple blocks per file and single-line blocks supported.

## Upgrading from the in-place hook

Earlier versions rewrote the source file on `PreToolUse Read` and restored it on `PostToolUse Edit|Write` and `Stop`. Replace that configuration with the one above; the new script ignores the old events (and says so on stderr) instead of filtering anything.

If a session with the old version ended without its `Stop` hook running, a source file may still hold `BLOCK_<hash>` placeholders. The old version kept each original as `.claude/.simplify-ignore-cache/<id>.bak`, with the file's path in `<id>.path`. Check out the previous `hooks/simplify-ignore.sh` from git history and run `echo '{}' | bash hooks/simplify-ignore.sh` once, or copy each `.bak` back to the path beside it, then delete the directory. The new hook reports such leftovers at `Stop` but never touches them.

## Known limitations

- **Edit cannot target a placeholder line.** Claude Code validates an Edit's `old_string` against the real file before any hook runs, so an `old_string` containing a placeholder fails with "string to replace not found". Nothing is changed. The note added to the Read result tells the model to choose an `old_string` without one, or to use Write with the whole file and every placeholder kept.
- **Line numbers drift after a placeholder.** The view keeps the real start line, but each placeholder stands for several real lines, so later line numbers in the view are lower than the real ones. Read offsets are real line numbers.
- **Only Read, Edit, and Write are covered.** A `Bash` command (`cat`, `sed`), a formatter, or another tool sees and changes the real file, protected blocks included. This is a convenience for `/code-simplify`, not a security boundary.
- **Auto mode may re-check a rewritten call.** In auto mode, Claude Code can deny a call whose input a hook changed after the server reviewed it. A denied Write changes nothing; repeat it or switch mode.
- **Single-line blocks hide the entire line.** If `simplify-ignore-start` and `simplify-ignore-end` appear on the same line as other code, the whole line is hidden. Use dedicated lines for annotations.
- **Comment suffix detection covers `*/` and `-->` only.** Template engines with other closers (ERB `%>`, Blade `--}}`) may produce unbalanced placeholders. Use `#` or `//` style comments instead.
- **Blocks cannot move between files.** A Write or Edit that carries another file's placeholder is denied, because the hook only knows the target file's blocks.

## Requirements

- `bash` and `node` (any current LTS). Without `node` the hook does nothing: no block is hidden and no file is changed.
