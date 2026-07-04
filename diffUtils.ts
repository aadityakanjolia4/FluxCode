export interface DiffStats {
  addedLines: number;
  removedLines: number;
  diffHtml: string;
}

export function computeDiff(original: string, updated: string): DiffStats {
  if (!original && !updated) {
    return { addedLines: 0, removedLines: 0, diffHtml: '<div class="no-diff">No changes</div>' };
  }

  const aLines = original.split('\n');
  const bLines = updated.split('\n');

  // Simple line-by-line diff using longest matching sequence
  const ops = simpleDiff(aLines, bLines);
  const addedLines = ops.filter(o => o.type === 'add').length;
  const removedLines = ops.filter(o => o.type === 'remove').length;

  if (addedLines === 0 && removedLines === 0) {
    return { addedLines: 0, removedLines: 0, diffHtml: '<div class="no-diff">No changes</div>' };
  }

  // Build hunks with 2 lines of context
  const CONTEXT = 2;
  const changed = new Set<number>();
  ops.forEach((op, i) => { if (op.type !== 'same') { changed.add(i); } });
  const visible = new Set<number>();
  changed.forEach(i => {
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++) {
      visible.add(j);
    }
  });

  const sortedVisible = [...visible].sort((a, b) => a - b);
  const hunks: number[][] = [];
  let currentHunk: number[] = [];
  for (const idx of sortedVisible) {
    if (currentHunk.length === 0 || idx === currentHunk[currentHunk.length - 1] + 1) {
      currentHunk.push(idx);
    } else {
      hunks.push(currentHunk);
      currentHunk = [idx];
    }
  }
  if (currentHunk.length > 0) { hunks.push(currentHunk); }

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let html = '';
  for (const hunk of hunks) {
    const hunkOps = hunk.map(i => ops[i]);
    const aStart = hunkOps.find(o => o.ai > 0)?.ai ?? 1;
    const bStart = hunkOps.find(o => o.bi > 0)?.bi ?? 1;
    const aCount = hunkOps.filter(o => o.ai > 0).length;
    const bCount = hunkOps.filter(o => o.bi > 0).length;

    html += '<div class="hunk">';
    html += `<div class="hunk-sep">@@ -${aStart},${aCount} +${bStart},${bCount} @@</div>`;

    for (const op of hunkOps) {
      const cls    = op.type === 'add' ? 'la' : op.type === 'remove' ? 'lr' : 'lu';
      const prefix = op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' ';
      const aLn    = op.ai > 0 ? String(op.ai) : '';
      const bLn    = op.bi > 0 ? String(op.bi) : '';
      html +=
        `<div class="dl ${cls}">` +
        `<span class="ln">${aLn}</span>` +
        `<span class="ln-div">│</span>` +
        `<span class="ln">${bLn}</span>` +
        `<span class="lp">${prefix}</span>` +
        `<span class="lc">${esc(op.text)}</span>` +
        `</div>`;
    }
    html += '</div>';
  }

  return { addedLines, removedLines, diffHtml: html };
}

// Simple, reliable line-by-line diff
function simpleDiff(aLines: string[], bLines: string[]): Array<{ type: 'same' | 'add' | 'remove'; ai: number; bi: number; text: string }> {
  const ops: Array<{ type: 'same' | 'add' | 'remove'; ai: number; bi: number; text: string }> = [];

  // Find longest common subsequence of actual matching lines
  const m = Math.min(aLines.length, 600);
  const n = Math.min(bLines.length, 600);

  // DP table: lcs length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find matching line indices
  const matches: Array<[number, number]> = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (aLines[i - 1] === bLines[j - 1]) {
      matches.unshift([i - 1, j - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  // Build ops from matches
  let ai = 0, bi = 0;
  for (const [matchAi, matchBi] of matches) {
    // Add removes for lines between last match and this match in A
    while (ai < matchAi) {
      ops.push({ type: 'remove', ai: ai + 1, bi: -1, text: aLines[ai] });
      ai++;
    }
    // Add adds for lines between last match and this match in B
    while (bi < matchBi) {
      ops.push({ type: 'add', ai: -1, bi: bi + 1, text: bLines[bi] });
      bi++;
    }
    // Add matching line
    ops.push({ type: 'same', ai: ai + 1, bi: bi + 1, text: aLines[ai] });
    ai++; bi++;
  }

  // Remaining lines in A (removes)
  while (ai < aLines.length) {
    ops.push({ type: 'remove', ai: ai + 1, bi: -1, text: aLines[ai] });
    ai++;
  }

  // Remaining lines in B (adds)
  while (bi < bLines.length) {
    ops.push({ type: 'add', ai: -1, bi: bi + 1, text: bLines[bi] });
    bi++;
  }

  return ops;
}
