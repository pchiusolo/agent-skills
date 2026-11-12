#!/bin/bash
# simplify-ignore-test.sh — Tests for the simplify-ignore hook
#
# Drives hooks/simplify-ignore.sh with the JSON Claude Code sends for each
# hook phase and checks the JSON it answers with. The invariant behind every
# test: the hook never changes the project. Each phase snapshots the sha256 of
# every file under the project (the source file included) before and after
# the hook runs, and the two snapshots must match. Only the simulated host
# write in the lifecycle test changes a file, and it must keep every
# protected block verbatim.
#
# Run: bash hooks/simplify-ignore-test.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$HERE/simplify-ignore.sh"

if ! command -v node >/dev/null 2>&1; then
  printf 'SKIP: node not available; the simplify-ignore hook no-ops without it\n'
  exit 0
fi

PASS=0 FAIL=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Windows (Git Bash) hands JSON paths to a native node; give it a mixed path.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
PROJ="$(winpath "$TMP/proj")"
mkdir -p "$PROJ"
export CLAUDE_PROJECT_DIR="$PROJ"

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
sha1() { if command -v sha1sum >/dev/null 2>&1; then sha1sum | cut -c1-8; else shasum | cut -c1-8; fi; }
# Every file under the project with its sha256, so a write anywhere shows up.
snapshot() { (cd "$PROJ" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\n' "$(sha256 "$f")" "$f"; done); }

OUT="$TMP/out.json" ERR="$TMP/err.txt" IN="$TMP/in.json"
RC=0
BEFORE=""

# run_hook — feed $IN to the hook; capture stdout, stderr, exit code, and
# assert the project tree is byte-for-byte unchanged.
run_hook() {
  local label="$1"
  BEFORE=$(snapshot)
  RC=0
  bash "$HOOK" < "$IN" > "$OUT" 2> "$ERR" || RC=$?
  assert_eq "$label: exit code 0" "0" "$RC"
  assert_eq "$label: every project file's sha256 unchanged" "$BEFORE" "$(snapshot)"
}

# out <js-expr over o> — a field of the hook's JSON answer ('' if absent).
out() {
  node -e "const raw=require('fs').readFileSync(0,'utf8');const o=raw?JSON.parse(raw):null;const v=(o=>{try{return $1}catch{return undefined}})(o);process.stdout.write(v===undefined||v===null?'':typeof v==='string'?v:JSON.stringify(v))" < "$OUT"
}

# Builders for the hook input Claude Code sends (shape observed on 2.1.322).
mk_read() { # file [startLine [limit]]
  node -e '
const fs=require("fs");const [f,cwd,start,limit]=process.argv.slice(1);
const lines=fs.readFileSync(f,"utf8").split("\n");
const s=Number(start||1);const l=limit?Number(limit):lines.length-s+1;
const content=lines.slice(s-1,s-1+l).join("\n");
process.stdout.write(JSON.stringify({hook_event_name:"PostToolUse",tool_name:"Read",cwd,tool_input:{file_path:f},
  tool_response:{type:"text",file:{filePath:f,content,numLines:l,startLine:s,totalLines:lines.length}}}));' "$1" "$PROJ" "${2:-}" "${3:-}" > "$IN"
}
mk_write() { # file content-file
  node -e '
const fs=require("fs");const [f,c,cwd]=process.argv.slice(1);
process.stdout.write(JSON.stringify({hook_event_name:"PreToolUse",tool_name:"Write",cwd,tool_input:{file_path:f,content:fs.readFileSync(c,"utf8")}}));' "$1" "$2" "$PROJ" > "$IN"
}
mk_edit() { # file old-file new-file [replace_all]
  node -e '
const fs=require("fs");const [f,o,n,cwd,all]=process.argv.slice(1);
const ti={file_path:f,old_string:fs.readFileSync(o,"utf8"),new_string:fs.readFileSync(n,"utf8")};
if(all)ti.replace_all=true;
process.stdout.write(JSON.stringify({hook_event_name:"PreToolUse",tool_name:"Edit",cwd,tool_input:ti}));' "$1" "$2" "$3" "$PROJ" "${4:-}" > "$IN"
}
mk_event() { # hook_event_name [tool_name]
  node -e 'const [e,t,cwd]=process.argv.slice(1);const o={hook_event_name:e,cwd};if(t)o.tool_name=t;process.stdout.write(JSON.stringify(o));' "$1" "${2:-}" "$PROJ" > "$IN"
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1)); printf '  PASS: %s\n' "$label"
  else
    FAIL=$((FAIL + 1)); printf '  FAIL: %s\n' "$label" >&2
    printf '    expected: %s\n' "$(printf '%s' "$expected" | cat -v)" >&2
    printf '    actual:   %s\n' "$(printf '%s' "$actual" | cat -v)" >&2
  fi
}
assert_contains() {
  case "$3" in *"$2"*) PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1" ;;
  *) FAIL=$((FAIL + 1)); printf '  FAIL: %s\n    missing: %s\n    in: %.300s\n' "$1" "$2" "$3" >&2 ;; esac
}
assert_not_contains() {
  case "$3" in *"$2"*) FAIL=$((FAIL + 1)); printf '  FAIL: %s\n    unexpected: %s\n' "$1" "$2" >&2 ;;
  *) PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1" ;; esac
}
assert_same_file() {
  if cmp -s "$2" "$3"; then PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"
  else FAIL=$((FAIL + 1)); printf '  FAIL: %s\n' "$1" >&2; diff "$2" "$3" | head -20 >&2 || true; fi
}

# ── Fixture: a JS file with one protected block. `&&` and backslashes guard
#    against replacement-side expansion bugs (bash patsub_replacement, $& in
#    JS String.replace).
SRC="$PROJ/src.js"
cat > "$SRC" <<'EOF'
const a = 1;
/* simplify-ignore-start: perf-critical */
// manually unrolled XOR
result[0] = buf[0] ^ key[0] && flag;
const re = /\d+\\/; const amp = '$&';
/* simplify-ignore-end */
function keep() { return a; }
EOF
H=$(printf '%s' "$(sed -n '2,6p' "$SRC")" | sha1)
PH="/* BLOCK_${H}: perf-critical */"

# ── Test 1: Read shows placeholders, never the protected code ────────────
printf 'Test 1: PostToolUse Read returns a filtered view\n'
mk_read "$SRC"; run_hook "read"
assert_eq "view replaces the block with one placeholder line" \
  "$(printf 'const a = 1;\n%s\nfunction keep() { return a; }\n' "$PH"; printf x)" \
  "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content'; printf x)"
assert_not_contains "protected code absent from the view" "manually unrolled" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content')"
assert_eq "numLines counts the view lines" "4" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.numLines')"
assert_eq "output keeps the Read tool's shape" "text" "$(out 'o.hookSpecificOutput.updatedToolOutput.type')"
assert_contains "model is told how placeholders work" "Edit cannot match a placeholder line" "$(out 'o.hookSpecificOutput.additionalContext')"
assert_eq "no cache directory created" "no" "$([ -e "$PROJ/.claude" ] && echo yes || echo no)"

# ── Test 2: Single-line block ─────────────────────────────────────────────
printf '\nTest 2: Single-line block (start+end on same line)\n'
F="$PROJ/single.js"
printf 'const a = 1;\n/* simplify-ignore-start */ const secret = 42; /* simplify-ignore-end */\nconst b = 2;\n' > "$F"
H2=$(printf '%s' '/* simplify-ignore-start */ const secret = 42; /* simplify-ignore-end */' | sha1)
mk_read "$F"; run_hook "single-line read"
assert_eq "one placeholder, neighbours kept" \
  "$(printf 'const a = 1;\n/* BLOCK_%s */\nconst b = 2;\n' "$H2"; printf x)" \
  "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content'; printf x)"

# ── Test 3: Comment styles keep their syntax ─────────────────────────────
printf '\nTest 3: Comment styles\n'
F="$PROJ/tuned.py"
printf 'x = 1\n# simplify-ignore-start: tuned\ny = x ** 2\n# simplify-ignore-end\n' > "$F"
mk_read "$F"; run_hook "python read"
assert_contains "python placeholder uses #" "# BLOCK_" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content')"
assert_contains "reason kept" ": tuned" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content')"
F="$PROJ/page.html"
printf '<p>a</p>\n<!-- simplify-ignore-start -->\n<b>x</b>\n<!-- simplify-ignore-end -->\n' > "$F"
mk_read "$F"; run_hook "html read"
assert_contains "html placeholder keeps the closer" " -->" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content' | grep BLOCK_)"
assert_contains "html placeholder keeps the opener" "<!-- BLOCK_" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content')"

# ── Test 4: Identical blocks share one placeholder ───────────────────────
printf '\nTest 4: Multiple and identical blocks\n'
F="$PROJ/twice.js"
printf '// simplify-ignore-start\nx();\n// simplify-ignore-end\nmid();\n// simplify-ignore-start\nx();\n// simplify-ignore-end\n' > "$F"
mk_read "$F"; run_hook "two identical blocks"
assert_eq "two placeholder lines" "2" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content' | grep -c BLOCK_)"
assert_eq "one hash for both" "1" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content' | grep -o 'BLOCK_[0-9a-f]*' | sort -u | wc -l | tr -d ' ')"

# ── Test 5: Unclosed block is shown and flagged ───────────────────────────
printf '\nTest 5: Unclosed block\n'
F="$PROJ/unclosed.js"
printf 'a();\n// simplify-ignore-start\nb();\n' > "$F"
mk_read "$F"; run_hook "unclosed read"
assert_eq "content shown as-is" "$(cat "$F"; printf x)" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content'; printf x)"
assert_contains "warning reaches the model" "unclosed simplify-ignore-start" "$(out 'o.hookSpecificOutput.additionalContext')"

# ── Test 6: A partial Read that starts inside a block ────────────────────
printf '\nTest 6: Partial Read (offset/limit inside a block)\n'
mk_read "$SRC" 3 2; run_hook "partial read"
assert_eq "only the placeholder is shown" "$PH" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content')"
assert_eq "startLine kept" "3" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.startLine')"

# ── Test 7-9: Pass-through cases ─────────────────────────────────────────
printf '\nTest 7: File without markers passes through\n'
F="$PROJ/plain.js"; printf 'plain();\n' > "$F"
mk_read "$F"; run_hook "plain read"
assert_eq "no answer" "" "$(cat "$OUT")"

printf '\nTest 8: The hook'"'"'s own files stay readable\n'
F="$PROJ/SIMPLIFY-IGNORE.md"; printf '/* simplify-ignore-start */\nexample\n/* simplify-ignore-end */\n' > "$F"
mk_read "$F"; run_hook "self-excluded read"
assert_eq "no answer" "" "$(cat "$OUT")"

printf '\nTest 9: Non-text Read results pass through\n'
node -e 'const [f,cwd]=process.argv.slice(1);process.stdout.write(JSON.stringify({hook_event_name:"PostToolUse",tool_name:"Read",cwd,tool_input:{file_path:f},tool_response:{type:"image",file:{base64:"AA=="}}}))' "$SRC" "$PROJ" > "$IN"
run_hook "image read"
assert_eq "no answer" "" "$(cat "$OUT")"

# ── Test 10: Write with placeholders kept is expanded ────────────────────
printf '\nTest 10: PreToolUse Write expands placeholders\n'
printf 'const a = 1;\n%s\nfunction kept() { return a; }\n' "$PH" > "$TMP/new.js"
sed 's/function keep()/function kept()/' "$SRC" > "$TMP/expected.js"
mk_write "$SRC" "$TMP/new.js"; run_hook "write"
out 'o.hookSpecificOutput.updatedInput.content' > "$TMP/written.js"
assert_same_file "updatedInput restores the real block around the model's change" "$TMP/expected.js" "$TMP/written.js"
assert_eq "file_path unchanged in updatedInput" "$SRC" "$(out 'o.hookSpecificOutput.updatedInput.file_path')"
assert_eq "no permission decision (host prompts still apply)" "" "$(out 'o.hookSpecificOutput.permissionDecision')"

# ── Test 11: Re-indented placeholder or edited reason still expands ──────
printf '\nTest 11: Fuzzy placeholder expansion\n'
printf 'const a = 1;\n    /* BLOCK_%s: changed reason */\nfunction keep() { return a; }\n' "$H" > "$TMP/fuzzy.js"
mk_write "$SRC" "$TMP/fuzzy.js"; run_hook "fuzzy write"
out 'o.hookSpecificOutput.updatedInput.content' > "$TMP/written.js"
assert_same_file "block restored verbatim" "$SRC" "$TMP/written.js"

# ── Test 12: A Write that drops a placeholder is denied ──────────────────
printf '\nTest 12: Write that drops protected code\n'
printf 'const a = 1;\nfunction keep() { return a; }\n' > "$TMP/dropped.js"
mk_write "$SRC" "$TMP/dropped.js"; run_hook "dropping write"
assert_eq "denied" "deny" "$(out 'o.hookSpecificOutput.permissionDecision')"
assert_contains "names the placeholder to keep" "$PH" "$(out 'o.hookSpecificOutput.permissionDecisionReason')"

# ── Test 13: Placeholders from another file are refused ──────────────────
printf '\nTest 13: Write that moves a block to another file\n'
printf 'moved();\n%s\n' "$PH" > "$TMP/moved.js"
mk_write "$PROJ/other.js" "$TMP/moved.js"; run_hook "foreign write"
assert_eq "denied" "deny" "$(out 'o.hookSpecificOutput.permissionDecision')"
assert_contains "explains the move" "cannot be moved between files" "$(out 'o.hookSpecificOutput.permissionDecisionReason')"

# ── Test 14-16: Edit ──────────────────────────────────────────────────────
printf '\nTest 14: Edit outside protected code is untouched\n'
printf 'function keep()' > "$TMP/old"; printf 'function kept()' > "$TMP/new"
mk_edit "$SRC" "$TMP/old" "$TMP/new"; run_hook "edit"
assert_eq "no answer, host applies the edit" "" "$(cat "$OUT")"

printf '\nTest 15: Edit that reaches into protected code is denied\n'
printf 'key' > "$TMP/old"; printf 'k2' > "$TMP/new"
mk_edit "$SRC" "$TMP/old" "$TMP/new" all; run_hook "replace_all edit"
assert_eq "replace_all into a block denied" "deny" "$(out 'o.hookSpecificOutput.permissionDecision')"
assert_contains "names the block" "BLOCK_$H" "$(out 'o.hookSpecificOutput.permissionDecisionReason')"
printf 'buf[0]' > "$TMP/old"
mk_edit "$SRC" "$TMP/old" "$TMP/new"; run_hook "single edit inside a block"
assert_eq "single edit into a block denied" "deny" "$(out 'o.hookSpecificOutput.permissionDecision')"

printf '\nTest 16: Edit whose new_string carries a placeholder is expanded\n'
printf 'function keep() { return a; }' > "$TMP/old"
printf 'function keep() { return a; }\n%s' "$PH" > "$TMP/new"
mk_edit "$SRC" "$TMP/old" "$TMP/new"; run_hook "edit with placeholder"
assert_contains "new_string carries the real block" "manually unrolled XOR" "$(out 'o.hookSpecificOutput.updatedInput.new_string')"
assert_not_contains "no placeholder left" "BLOCK_" "$(out 'o.hookSpecificOutput.updatedInput.new_string')"

# ── Test 17: Stop restores nothing because nothing changed ───────────────
printf '\nTest 17: Stop\n'
mk_event Stop; run_hook "stop"
assert_eq "no answer" "" "$(cat "$OUT")"
printf '{}' > "$IN"; run_hook "manual recovery call (echo {} | hook)"
mkdir -p "$PROJ/.claude/.simplify-ignore-cache"
printf 'old backup\n' > "$PROJ/.claude/.simplify-ignore-cache/abc.bak"
mk_event Stop; run_hook "stop with leftovers from the in-place hook"
assert_contains "leftovers reported, not restored" "old in-place version" "$(cat "$ERR")"
rm -rf "$PROJ/.claude"

# ── Test 18-19: Old configuration and bad input are harmless ─────────────
printf '\nTest 18: Events from the old in-place configuration\n'
node -e 'const [f,cwd]=process.argv.slice(1);process.stdout.write(JSON.stringify({hook_event_name:"PreToolUse",tool_name:"Read",cwd,tool_input:{file_path:f}}))' "$SRC" "$PROJ" > "$IN"
run_hook "PreToolUse Read"
assert_eq "no answer" "" "$(cat "$OUT")"
assert_contains "points at the new configuration" "PostToolUse Read" "$(cat "$ERR")"

printf '\nTest 19: Malformed hook input\n'
printf 'not json' > "$IN"; run_hook "malformed input"
assert_contains "diagnostic on stderr" "could not parse hook input" "$(cat "$ERR")"

# ── Test 20: CRLF files round-trip exactly ───────────────────────────────
printf '\nTest 20: CRLF line endings\n'
F="$PROJ/crlf.js"
printf 'a();\r\n// simplify-ignore-start\r\nsecret();\r\n// simplify-ignore-end\r\nb();\r\n' > "$F"
mk_read "$F"; run_hook "crlf read"
out 'o.hookSpecificOutput.updatedToolOutput.file.content' > "$TMP/view.js"
assert_not_contains "block hidden" "secret" "$(cat "$TMP/view.js")"
mk_write "$F" "$TMP/view.js"; run_hook "crlf write of the unchanged view"
if [ -s "$OUT" ]; then out 'o.hookSpecificOutput.updatedInput.content' > "$TMP/written.js"; else cp "$TMP/view.js" "$TMP/written.js"; fi
assert_same_file "expanded view equals the real file" "$F" "$TMP/written.js"

# ── Test 21: Missing node degrades to a harmless no-op ───────────────────
printf '\nTest 21: Missing node\n'
mkdir -p "$TMP/empty-path"
mk_read "$SRC"
BEFORE=$(snapshot); RC=0
PATH="$TMP/empty-path" "$BASH" "$HOOK" < "$IN" > "$OUT" 2> "$ERR" || RC=$?
assert_eq "exit 0" "0" "$RC"
assert_contains "diagnostic names node" "node is required" "$(cat "$ERR")"
assert_eq "every project file's sha256 unchanged" "$BEFORE" "$(snapshot)"

# ── Test 22: Full lifecycle ──────────────────────────────────────────────
printf '\nTest 22: Read -> Write -> Read -> Stop lifecycle\n'
cp "$SRC" "$TMP/original.js"
mk_read "$SRC"; run_hook "lifecycle read"
out 'o.hookSpecificOutput.updatedToolOutput.file.content' | sed 's/return a;/return a + 1;/' > "$TMP/model.js"
mk_write "$SRC" "$TMP/model.js"; run_hook "lifecycle write"
out 'o.hookSpecificOutput.updatedInput.content' > "$TMP/host-writes.js"
cp "$TMP/host-writes.js" "$SRC"   # the host's Write tool, not the hook, writes the file
sed 's/return a;/return a + 1;/' "$TMP/original.js" > "$TMP/expected.js"
assert_same_file "file holds the model's change and the untouched block" "$TMP/expected.js" "$SRC"
mk_read "$SRC"; run_hook "lifecycle re-read"
assert_contains "same placeholder after the write" "$PH" "$(out 'o.hookSpecificOutput.updatedToolOutput.file.content')"
mk_event Stop; run_hook "lifecycle stop"
assert_same_file "Stop leaves the file as the host wrote it" "$TMP/expected.js" "$SRC"

printf '\n══════════════════════════════════════════\n'
printf 'Results: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
