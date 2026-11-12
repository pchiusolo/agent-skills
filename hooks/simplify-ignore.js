#!/usr/bin/env node
/**
 * simplify-ignore.js — hide simplify-ignore blocks from the model without
 * touching the file on disk. Entry point: hooks/simplify-ignore.sh.
 *
 *   PostToolUse Read   → replaces the Read result with a filtered view
 *                        (hookSpecificOutput.updatedToolOutput)
 *   PreToolUse Write   → expands BLOCK_<hash> placeholders in the new content
 *                        (hookSpecificOutput.updatedInput); denies a Write that
 *                        would drop a protected block
 *   PreToolUse Edit    → denies an Edit that would change a protected block;
 *                        expands placeholders in new_string
 *   Stop               → nothing to restore; warns about files left by the old
 *                        in-place version of this hook
 *
 * The hook never writes to the project or anywhere else: the file on disk is
 * always the real file, and every phase recomputes the blocks from it. It is
 * a convenience for /code-simplify, not a security boundary: a Bash read, or
 * a host that ignores updatedToolOutput, shows the real code.
 *
 * Exit codes: always 0. Decisions travel in the JSON on stdout.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const START = 'simplify-ignore-start';
const END = 'simplify-ignore-end';
const TOKEN_RE = /BLOCK_[0-9a-f]{8}/g;
const LEGACY_CACHE = path.join('.claude', '.simplify-ignore-cache');

// ─── Parsing ─────────────────────────────────────────────────────────────────

function reasonOf(line) {
  const at = line.indexOf(`${START}:`);
  if (at < 0) return '';
  return line
    .slice(at + START.length + 1)
    .replace(/^\s+/, '')
    .replace(/\s*\*\/.*$/, '')
    .replace(/\s*-->.*$/, '')
    .replace(/\s+$/, '');
}

/**
 * Splits text into the view the model sees. Each view line records the real
 * line range (1-based, inclusive) it stands for. Blocks are content-hashed, so
 * identical blocks share one placeholder.
 */
function parse(text) {
  const lines = text.split('\n');
  const view = [];
  const blocks = new Map();
  const warnings = [];
  let open = null;

  const close = (endIdx) => {
    const content = open.buf.join('\n');
    const hash = crypto.createHash('sha1').update(content).digest('hex').slice(0, 8);
    const { prefix, suffix, reason } = open;
    const placeholder = `${prefix}BLOCK_${hash}${reason ? `: ${reason}` : ''}${suffix}`;
    const cr = lines[endIdx].endsWith('\r') ? '\r' : '';
    blocks.set(hash, { hash, content, prefix, suffix, reason, placeholder });
    view.push({ text: placeholder + cr, start: open.start + 1, end: endIdx + 1 });
    open = null;
  };

  lines.forEach((line, i) => {
    if (!open && line.includes(START)) {
      open = {
        start: i,
        buf: [line],
        prefix: line.slice(0, line.indexOf(START)),
        suffix: line.includes('*/') ? ' */' : line.includes('-->') ? ' -->' : '',
        reason: reasonOf(line),
      };
      if (line.includes(END)) close(i);
      return;
    }
    if (open) {
      open.buf.push(line);
      if (line.includes(END)) close(i);
      return;
    }
    view.push({ text: line, start: i + 1, end: i + 1 });
  });

  if (open) {
    warnings.push(`unclosed ${START} at line ${open.start + 1}; that block is not hidden`);
    open.buf.forEach((line, k) => view.push({ text: line, start: open.start + k + 1, end: open.start + k + 1 }));
  }
  return { view, blocks, warnings };
}

// ─── Expansion ───────────────────────────────────────────────────────────────

/**
 * Replaces each placeholder of a known block with the block's real code. A
 * placeholder line, even re-indented or with its reason text changed, is
 * replaced whole; a placeholder inside other code is replaced in place.
 */
function expand(text, blocks) {
  if (!text.includes('BLOCK_') || blocks.size === 0) return text;
  return text
    .split('\n')
    .map((line) => {
      let out = line;
      for (const block of blocks.values()) {
        const token = `BLOCK_${block.hash}`;
        if (!out.includes(token)) continue;
        const trimmed = out.trim();
        if (trimmed === block.placeholder.trim() || trimmed.startsWith(`${block.prefix.trimStart()}${token}`)) {
          out = block.content;
        } else if (out.includes(block.placeholder.trimStart())) {
          out = out.replace(block.placeholder.trimStart(), () => block.content);
        } else {
          out = out.replace(token, () => block.content);
        }
      }
      return out;
    })
    .join('\n');
}

function count(haystack, needle) {
  let n = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) n++;
  return n;
}

/** Blocks of `before` that occur fewer times in `after`, i.e. would be lost. */
function lostBlocks(before, after, blocks) {
  return [...blocks.values()].filter((b) => count(after, b.content) < count(before, b.content));
}

/** Placeholder-shaped tokens in `text` that `real` neither contains nor defines. */
function foreignTokens(text, real, blocks) {
  return [...new Set(text.match(TOKEN_RE) ?? [])].filter((t) => !blocks.has(t.slice(6)) && !real.includes(t));
}

// ─── Hook I/O ────────────────────────────────────────────────────────────────

function emit(event, fields) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...fields } }));
}

function deny(reason) {
  emit('PreToolUse', { permissionDecision: 'deny', permissionDecisionReason: `simplify-ignore: ${reason}` });
}

function readReal(input) {
  const filePath = input.tool_input?.file_path;
  if (!filePath) return null;
  const base = path.basename(filePath);
  if (/^simplify-ignore/i.test(base)) return null; // the hook, its test, and its docs stay readable
  const abs = path.resolve(input.cwd || process.cwd(), filePath);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function onRead(input) {
  const real = readReal(input);
  const file = input.tool_response?.file;
  if (!real || !real.includes(START) || input.tool_response?.type !== 'text' || typeof file?.content !== 'string') return;
  const { view, blocks, warnings } = parse(real);
  if (blocks.size === 0 && warnings.length === 0) return;

  const first = file.startLine || 1;
  const last = first + file.content.split('\n').length - 1;
  const keepCR = file.content.includes('\r');
  const shown = view
    .filter((v) => v.end >= first && v.start <= last)
    .map((v) => (keepCR ? v.text : v.text.replace(/\r$/, '')));

  const notes = [];
  if (blocks.size > 0) {
    notes.push(
      `simplify-ignore: ${blocks.size} protected block(s) in this file are shown as BLOCK_<hash> placeholder lines. ` +
        'The code they stand for is intentionally hidden and must stay unchanged: keep every placeholder line exactly as shown. ' +
        'Edit cannot match a placeholder line, so pick an old_string that does not include one, or use Write with the whole file and every placeholder line kept. ' +
        'Line numbers after a placeholder are offset by the lines it hides.',
    );
  }
  for (const w of warnings) notes.push(`simplify-ignore: ${w}`);

  emit('PostToolUse', {
    updatedToolOutput: { ...input.tool_response, file: { ...file, content: shown.join('\n'), numLines: shown.length } },
    additionalContext: notes.join('\n'),
  });
}

function onWrite(input) {
  const content = input.tool_input?.content;
  const real = readReal(input);
  if (real === null || typeof content !== 'string') return;
  if (!real.includes(START) && !content.includes('BLOCK_')) return;
  const { blocks } = parse(real);

  const expanded = expand(content, blocks);
  const foreign = foreignTokens(expanded, real, blocks);
  if (foreign.length) {
    return deny(`this Write carries placeholder(s) ${foreign.join(', ')} that do not belong to ${input.tool_input.file_path}. Protected blocks cannot be moved between files; leave them in their own file.`);
  }
  const lost = lostBlocks(real, expanded, blocks);
  if (lost.length) {
    return deny(`this Write drops protected code you cannot see. Keep each of these placeholder lines exactly as shown, then write again:\n${lost.map((b) => `  ${b.placeholder}`).join('\n')}`);
  }
  if (expanded !== content) emit('PreToolUse', { updatedInput: { ...input.tool_input, content: expanded } });
}

function onEdit(input) {
  const { old_string: oldString, new_string: newString, replace_all: replaceAll } = input.tool_input ?? {};
  const real = readReal(input);
  if (!real || !real.includes(START) || typeof oldString !== 'string' || typeof newString !== 'string') return;
  const { blocks } = parse(real);
  if (blocks.size === 0) return;

  const expandedNew = expand(newString, blocks);
  const foreign = foreignTokens(expandedNew, real, blocks);
  if (foreign.length) {
    return deny(`this Edit inserts placeholder(s) ${foreign.join(', ')} that do not belong to ${input.tool_input.file_path}. Protected blocks cannot be moved between files.`);
  }
  let after;
  if (replaceAll) {
    after = real.split(oldString).join(expandedNew);
  } else {
    const at = real.indexOf(oldString);
    if (at < 0) return; // the host matched it some other way; nothing to simulate
    after = real.slice(0, at) + expandedNew + real.slice(at + oldString.length);
  }
  const lost = lostBlocks(real, after, blocks);
  if (lost.length) {
    return deny(`this Edit would change protected code hidden as ${lost.map((b) => b.placeholder.trim()).join(', ')}. Protected blocks cannot be edited while simplify-ignore is active; change only the code around them.`);
  }
  if (expandedNew !== newString) emit('PreToolUse', { updatedInput: { ...input.tool_input, new_string: expandedNew } });
}

function onStop(input) {
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const legacy = path.join(root, LEGACY_CACHE);
  let leftovers = [];
  try {
    leftovers = fs.readdirSync(legacy).filter((f) => f.endsWith('.bak') || f.endsWith('.recovered'));
  } catch {
    return;
  }
  if (leftovers.length) {
    process.stderr.write(
      `simplify-ignore: ${legacy} holds ${leftovers.length} file(s) left by the old in-place version of this hook. ` +
        'A source file may still contain BLOCK_ placeholders; see hooks/SIMPLIFY-IGNORE.md, "Upgrading from the in-place hook". Nothing was changed.\n',
    );
  }
}

function main() {
  let input;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write(`simplify-ignore: could not parse hook input (${e.message}); nothing was hidden or changed.\n`);
    return;
  }
  const event = input.hook_event_name || (input.tool_name ? '' : 'Stop');
  const tool = input.tool_name;

  if (event === 'PostToolUse' && tool === 'Read') return onRead(input);
  if (event === 'PreToolUse' && tool === 'Write') return onWrite(input);
  if (event === 'PreToolUse' && tool === 'Edit') return onEdit(input);
  if (event === 'Stop' || event === 'SessionEnd') return onStop(input);
  if ((event === 'PreToolUse' && tool === 'Read') || (event === 'PostToolUse' && (tool === 'Edit' || tool === 'Write'))) {
    process.stderr.write(
      'simplify-ignore: this event belongs to the old in-place configuration. The hook now runs on PostToolUse Read and PreToolUse Edit|Write; update .claude/settings.json (see hooks/SIMPLIFY-IGNORE.md). Nothing was hidden or changed.\n',
    );
  }
}

main();
