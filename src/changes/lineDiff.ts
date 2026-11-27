const MAX_DIFF_LINES = 6000;
const MAX_EDIT_DISTANCE = 3000;

export function countLineChanges(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  const shared = Math.min(a.length, b.length);
  while (start < shared && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const left = a.slice(start, endA + 1);
  const right = b.slice(start, endB + 1);
  if (!left.length) return { added: right.length, removed: 0 };
  if (!right.length) return { added: 0, removed: left.length };
  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) return estimate(left, right);

  const distance = editDistance(left, right);
  if (distance === undefined) return estimate(left, right);
  const delta = right.length - left.length;
  return { added: (distance + delta) / 2, removed: (distance - delta) / 2 };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Myers greedy forward pass; returns the edit script length, or undefined when it grows past the cap. */
function editDistance(a: string[], b: string[]): number | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return d;
    }
  }
  return undefined;
}

function estimate(a: string[], b: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of b) {
    const left = counts.get(line);
    if (left) counts.set(line, left - 1);
    else added++;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}
