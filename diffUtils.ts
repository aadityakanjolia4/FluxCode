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
  const lcs = computeLCS(aLines.slice(0, 600), bLines.slice(0, 600));

  type DiffOp = { type: 'same' | 'add' | 'remove'; ai: number; bi: number; text: string };
  const ops: DiffOp[] = [];

  let ai = 0, bi = 0, li = 0;
  while (ai < aLines.length || bi < bLines.length) {
    if (
      li < lcs.length &&
      ai < aLines.length &&
      bi < bLines.length &&
      aLines[ai] === lcs[li] &&
      bLines[bi] === lcs[li]
    ) {
      ops.push({ type: 'same', ai: ai + 1, bi: bi + 1, text: aLines[ai] });
      ai++; bi++; li++;
    } else if (bi < bLines.length && (li >= lcs.length || bLines[bi] !== lcs[li])) {
      ops.push({ type: 'add', ai: -1, bi: bi + 1, text: bLines[bi] });
      bi++;
    } else {
      ops.push({ type: 'remove', ai: ai + 1, bi: -1, text: aLines[ai] });
      ai++;
    }
  }

  const addedLines = ops.filter(o => o.type === 'add').length;
  const removedLines = ops.filter(o => o.type === 'remove').length;

  if (addedLines === 0 && removedLines === 0) {
    return { addedLines: 0, removedLines: 0, diffHtml: '<div class="no-diff">No changes</div>' };
  }

  // Build hunks with 3 lines of context
  const CONTEXT = 3;
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

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const res: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) { res.unshift(a[i - 1]); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { i--; } else { j--; }
  }
  return res;
}
