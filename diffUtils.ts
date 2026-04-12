export interface DiffStats {
  addedLines: number;
  removedLines: number;
  diffHtml: string;
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  lineNo: number; // line number in the NEW file (for added/unchanged), OLD file for removed
}

const CONTEXT = 4;

export function computeDiff(original: string, updated: string): DiffStats {
  const aLines = original.split('\n');
  const bLines = updated.split('\n');

  const diffLines = buildDiff(aLines, bLines);

  const added = diffLines.filter((l) => l.type === 'added').length;
  const removed = diffLines.filter((l) => l.type === 'removed').length;

  const html = renderHtml(diffLines);
  return { addedLines: added, removedLines: removed, diffHtml: html };
}

function buildDiff(a: string[], b: string[]): DiffLine[] {
  // LCS capped at 600 lines for performance
  const aS = a.slice(0, 600);
  const bS = b.slice(0, 600);
  const lcs = computeLCS(aS, bS);

  const result: DiffLine[] = [];
  let ai = 0, bi = 0, li = 0;

  while (ai < aS.length || bi < bS.length) {
    if (
      li < lcs.length &&
      ai < aS.length &&
      bi < bS.length &&
      aS[ai] === lcs[li] &&
      bS[bi] === lcs[li]
    ) {
      result.push({ type: 'unchanged', content: bS[bi], lineNo: bi + 1 });
      ai++; bi++; li++;
    } else if (bi < bS.length && (li >= lcs.length || bS[bi] !== lcs[li])) {
      result.push({ type: 'added', content: bS[bi], lineNo: bi + 1 });
      bi++;
    } else {
      result.push({ type: 'removed', content: aS[ai], lineNo: ai + 1 });
      ai++;
    }
  }

  return result;
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

function renderHtml(lines: DiffLine[]): string {
  if (lines.length === 0) { return '<div class="no-diff">No changes</div>'; }

  // Find indices of changed lines
  const changedIdx = lines.map((l, i) => ({ l, i }))
    .filter(({ l }) => l.type !== 'unchanged')
    .map(({ i }) => i);

  if (changedIdx.length === 0) {
    return '<div class="no-diff">No changes detected</div>';
  }

  // Build ranges with context
  const ranges: { s: number; e: number }[] = [];
  let cur = { s: Math.max(0, changedIdx[0] - CONTEXT), e: Math.min(lines.length - 1, changedIdx[0] + CONTEXT) };
  for (let k = 1; k < changedIdx.length; k++) {
    const ns = Math.max(0, changedIdx[k] - CONTEXT);
    const ne = Math.min(lines.length - 1, changedIdx[k] + CONTEXT);
    if (ns <= cur.e + 1) { cur.e = ne; }
    else { ranges.push(cur); cur = { s: ns, e: ne }; }
  }
  ranges.push(cur);

  let html = '';
  for (let ri = 0; ri < ranges.length; ri++) {
    const { s, e } = ranges[ri];
    if (ri > 0) { html += '<div class="hunk-sep">···</div>'; }
    html += '<div class="hunk">';
    for (let i = s; i <= e; i++) {
      const line = lines[i];
      const cls = line.type === 'added' ? 'la' : line.type === 'removed' ? 'lr' : 'lu';
      const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' ';
      const content = esc(line.content);
      html += `<div class="dl ${cls}"><span class="ln">${line.lineNo}</span><span class="lp">${prefix}</span><span class="lc">${content}</span></div>`;
    }
    html += '</div>';
  }
  return html;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
