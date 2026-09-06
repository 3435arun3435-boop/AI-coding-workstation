'use strict';
/**
 * diff.js
 *
 * Zero-dependency line diffing (LCS-based) for the approval/diff system.
 * Produces structured hunks for the UI and a git-style unified diff string.
 * Bounded: files larger than MAX_DIFF_LINES fall back to a whole-file
 * replace summary rather than an O(n*m) blowup.
 */

const MAX_DIFF_LINES = 5000;

/**
 * Diff two texts line by line.
 * Returns [{ type: 'ctx'|'add'|'del', oldLine, newLine, text }]
 * where oldLine/newLine are 1-based numbers of the line in the old/new file
 * (null when not applicable).
 */
function diffLines(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    // Degenerate to whole-file replace — honest, bounded, still reviewable.
    const ops = [];
    for (let i = 0; i < a.length; i++) ops.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i] });
    for (let i = 0; i < b.length; i++) ops.push({ type: 'add', oldLine: null, newLine: i + 1, text: b[i] });
    return ops;
  }

  const n = a.length;
  const m = b.length;
  // LCS length table (Uint32 rows to keep memory sane).
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', oldLine: null, newLine: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i++] });
  while (j < m) ops.push({ type: 'add', oldLine: null, newLine: j + 1, text: b[j++] });
  return ops;
}

/** { additions, deletions, context } counts for a diffLines() result. */
function diffStats(ops) {
  let additions = 0;
  let deletions = 0;
  let context = 0;
  for (const op of ops) {
    if (op.type === 'add') additions++;
    else if (op.type === 'del') deletions++;
    else context++;
  }
  return { additions, deletions, context };
}

/**
 * Git-style unified diff string with `context` lines of context.
 * Empty-string return means the texts are identical.
 */
function unifiedDiff(oldText, newText, opts = {}) {
  const context = opts.context ?? 3;
  const oldName = opts.oldName || 'a';
  const newName = opts.newName || 'b';
  const ops = diffLines(oldText, newText);
  if (ops.every((o) => o.type === 'ctx')) return '';

  const lines = [`--- ${oldName}`, `+++ ${newName}`];
  let idx = 0;
  const n = ops.length;
  while (idx < n) {
    // Find the next non-context op.
    while (idx < n && ops[idx].type === 'ctx') idx++;
    if (idx >= n) break;
    // Walk back up to `context` context lines for the hunk header.
    let start = idx;
    let back = 0;
    while (start > 0 && ops[start - 1].type === 'ctx' && back < context) {
      start--;
      back++;
    }
    // Extend forward to cover the change plus `context` trailing context.
    let end = idx;
    let lastChange = idx;
    while (end < n) {
      if (ops[end].type !== 'ctx') lastChange = end;
      if (lastChange < n && end - lastChange >= context && ops[end].type === 'ctx') break;
      end++;
    }
    const hunkOps = ops.slice(start, end);
    const oldStart = (hunkOps.find((o) => o.oldLine != null) || { oldLine: 1 }).oldLine;
    const newStart = (hunkOps.find((o) => o.newLine != null) || { newLine: 1 }).newLine;
    const oldCount = hunkOps.filter((o) => o.oldLine != null).length;
    const newCount = hunkOps.filter((o) => o.newLine != null).length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunkOps) {
      const sign = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
      lines.push(sign + op.text);
    }
    idx = end;
  }
  return lines.join('\n') + '\n';
}

module.exports = { diffLines, diffStats, unifiedDiff, MAX_DIFF_LINES };
