// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON tool-call edits), finds the lines each edit names at the first
// of three matching tiers, and applies every change or none, exactly as
// SPEC.md says. Node 22, standard library only; run as
// `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// When MAKEFUN_ENV_URL is set this file hands over to runner.ts, which runs
// the trial's checks; keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

// A patch-level failure: exit 2 with `error: parse <line>`.
class ParseErr {
  readonly line: number;
  constructor(line: number) {
    this.line = line;
  }
}

// One edit's failure: exit 1 with `error: <code> <path>`.
class EditFail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

// A patch's lines: split at \n, one trailing \r removed from each, and the
// empty piece after a final \n dropped. Line numbers count these from 1.
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// SPEC section 3: a path is safe when it is not empty, does not start with
// `/`, holds no `\`, and none of its `/`-separated segments is empty, `.`
// or `..`.
function safePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// A file as lines plus its line break and whether it ends with one. The
// break is CRLF when the file's first line feed follows a carriage return,
// LF otherwise; an empty file has no lines and no final break.
interface FileLines {
  lines: string[];
  br: string;
  ends: boolean;
}

function splitText(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function joinLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

// SPEC section 5: a line's key at a matching tier. Tier 0 is the line
// itself, tier 1 drops trailing spaces and tabs, tier 2 drops leading and
// trailing spaces and tabs.
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

// SPEC section 5, tier 2 re-indentation: F is the leading whitespace of the
// file's first matched line, P that of O's first line. A non-blank line of N
// that starts with P has that P replaced by F; any other line is unchanged.
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

// Positions i >= from where old lines O match the file's lines at a tier.
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length - from) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== tierKey(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier at which O occurs at least once (tier 0 only with
// --strict), with every occurrence at that tier.
function firstTier(lines: string[], old: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// One body line of a unified hunk or a V4A chunk: context, removed, added,
// or a `\` marker line (which only marks the line before it).
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'mark';
  text: string;
}

function bodyLineOf(line: string): BodyLine {
  if (line === '') return { kind: 'ctx', text: '' };
  const c = line[0]!;
  if (c === ' ') return { kind: 'ctx', text: line.slice(1) };
  if (c === '-') return { kind: 'del', text: line.slice(1) };
  if (c === '+') return { kind: 'add', text: line.slice(1) };
  return { kind: 'mark', text: line.slice(1) };
}

// Split a hunk/chunk body into O (context + removed lines) and N (context +
// added lines). nFrom[j] is the index into O of N[j] when N[j] is a context
// line, and null when N[j] is an added line.
function splitBody(body: BodyLine[]): { o: string[]; n: string[]; nFrom: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nFrom: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push(b.text);
      nFrom.push(o.length - 1);
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else if (b.kind === 'add') {
      n.push(b.text);
      nFrom.push(null);
    }
  }
  return { o, n, nFrom };
}

// Build the lines that replace the matched lines at position `at`: context
// lines are written as the file's own matched lines, added lines as they
// are (tiers 0 and 1) or re-indented (tier 2).
function replacement(fileLines: string[], at: number, tier: number, o: string[], n: string[], nFrom: (number | null)[]): string[] {
  const p = leadingWs(o[0]!);
  const f = leadingWs(fileLines[at]!);
  return n.map((ln, j) => {
    const oi = nFrom[j];
    if (oi !== null && oi !== undefined) return fileLines[at + oi]!;
    if (tier === 2) return reindent(ln, p, f);
    return ln;
  });
}

// Whether a `\` line follows the body's last context or added line.
function backslashAfterLast(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    const k = body[j]!.kind;
    if (k === 'ctx' || k === 'add') {
      return j + 1 < body.length && body[j + 1]!.kind === 'mark';
    }
  }
  return false;
}

// The tree as the edits leave it: paths changed in `now` (null: deleted),
// everything else read from disk on first use.
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

// One edit: it mutates the tree or throws EditFail, and returns the move it
// performed, if any, so the report can print an `R` line for it.
type Edit = (tree: Tree) => { old: string; next: string } | void;

// Detect the patch format (SPEC section 4), or null when none holds.
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- JSON ---

// One JSON edit object (SPEC section 9), or null when the value is not one.
// Keys other than the ones below are ignored.
function jsonEdit(v: unknown, strict: boolean): Edit | null {
  void strict;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const f = splitText(before);
      if (line < 0 || line > f.lines.length) throw new EditFail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinLines(f));
    };
  }
  return null;
}

// Read the patch as JSON edits: one JSON array of edit objects, or JSON
// Lines with one edit object a line, blank lines ignored. In array form any
// fault is `error: parse <the line where the array starts>`; in JSON Lines
// form a line that does not hold one valid edit object is
// `error: parse <that line>`.
function parseJson(text: string, lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseErr(first + 1);
    for (const x of v) {
      const e = jsonEdit(x, strict);
      if (e === null) throw new ParseErr(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l), strict);
    } catch {
      e = null;
    }
    if (e === null) throw new ParseErr(i + 1);
    edits.push(e);
  });
  return edits;
}

// ------------------------------------------------------------- unified ---

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface UniSection {
  diffOld?: string;
  diffNew?: string;
  dashOld?: string;
  dashNew?: string;
  renameFrom?: string;
  renameTo?: string;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

// The path after `--- ` or `+++ `: text up to the first tab, surrounding
// spaces removed, one leading `a/` or `b/` removed.
function headerPath(s: string): string {
  const cut = s.split('\t')[0]!;
  const t = cut.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

// Read one hunk body starting at index i; the body ends at the first line
// that is not a body line, at a `diff --git ` line, at a `--- ` line followed
// by a `+++ ` line, or at the end of the patch. Empty lines at the end of a
// body are not part of it.
function readHunkBody(lines: string[], i: number): { body: BodyLine[]; next: number } {
  const body: BodyLine[] = [];
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
      body.push(bodyLineOf(line));
      i++;
    } else {
      break;
    }
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  return { body, next: i };
}

// Parse one section's header and hunks, starting at index i (the line after
// its `diff --git` line, or its `--- ` line when it started there). Returns
// the index of the next unconsumed line and appends the section's edit.
function parseUniSection(lines: string[], start: number, sec: UniSection, strict: boolean, edits: Edit[]): number {
  const n = lines.length;
  let i = start;
  let inHeader = true;
  let hasPair = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      break;
    }
    if (inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (hasPair) break;
          sec.dashOld = headerPath(line.slice(4));
          sec.dashNew = headerPath(lines[i + 1]!.slice(4));
          hasPair = true;
          i += 2;
          continue;
        }
        throw new ParseErr(i + 2);
      }
      if (line.startsWith('@@')) {
        const hm = HUNK_RE.exec(line);
        if (hm === null) throw new ParseErr(i + 1);
        const r = readHunkBody(lines, i + 1);
        sec.hunks.push({ a: Number(hm[1]), body: r.body });
        i = r.next;
        inHeader = false;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.isCreate = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const hm = HUNK_RE.exec(line);
      if (hm === null) throw new ParseErr(i + 1);
      const r = readHunkBody(lines, i + 1);
      sec.hunks.push({ a: Number(hm[1]), body: r.body });
      i = r.next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }
  edits.push(makeUniEdit(sec, strict));
  return i;
}

// Apply a section's hunks in order to a file's text. d is the running sum
// of (N length minus O length) over the hunks applied so far.
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitText(text);
  let d = 0;
  for (const h of hunks) {
    const { o, n, nFrom } = splitBody(h.body);
    const backslash = backslashAfterLast(h.body);
    if (o.length > 0) {
      const found = firstTier(f.lines, o, strict, 0);
      if (found === null) throw new EditFail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bd = Math.abs(best - target);
      for (const p of found.occ) {
        const dd = Math.abs(p - target);
        if (dd < bd) {
          bd = dd;
          best = p;
        }
      }
      const rep = replacement(f.lines, best, found.tier, o, n, nFrom);
      if (best + o.length === f.lines.length) f.ends = !backslash;
      f.lines.splice(best, o.length, ...rep);
      d += n.length - o.length;
    } else {
      const at = Math.min(h.a + d, f.lines.length);
      if (at === f.lines.length) f.ends = !backslash;
      f.lines.splice(at, 0, ...n);
      d += n.length;
    }
  }
  return joinLines(f);
}

// Turn one parsed section into its edit: a creation, a deletion, a move, or
// a change of the one path.
function makeUniEdit(sec: UniSection, strict: boolean): Edit {
  let oldP: string | null = sec.dashOld ?? sec.renameFrom ?? sec.diffOld ?? null;
  let newP: string | null = sec.dashNew ?? sec.renameTo ?? sec.diffNew ?? null;
  if (oldP === '/dev/null') oldP = null;
  if (newP === '/dev/null') newP = null;
  const oldPath = oldP;
  const newPath = newP;
  const create = sec.isCreate || oldPath === null;
  const del = !create && (sec.isDelete || newPath === null);
  const move = !create && !del && oldPath !== null && newPath !== null && oldPath !== newPath;
  if (create) {
    const lines: string[] = [];
    let ends = true;
    for (const h of sec.hunks) {
      let lastPlus = -1;
      for (let j = 0; j < h.body.length; j++) if (h.body[j]!.kind === 'add') lastPlus = j;
      if (lastPlus >= 0) ends = !(lastPlus + 1 < h.body.length && h.body[lastPlus + 1]!.kind === 'mark');
      for (const b of h.body) if (b.kind === 'add') lines.push(b.text);
    }
    return (tree) => {
      const p = newPath ?? '';
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, lines.length === 0 ? '' : lines.join('\n') + (ends ? '\n' : ''));
    };
  }
  if (del) {
    return (tree) => {
      const p = oldPath ?? '';
      if (!safePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) === null) throw new EditFail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (move) {
    const from = oldPath!;
    const to = newPath!;
    return (tree) => {
      if (!safePath(from)) throw new EditFail('unsafe', from);
      if (!safePath(to)) throw new EditFail('unsafe', to);
      const before = tree.get(from);
      if (before === null) throw new EditFail('missing', from);
      if (tree.get(to) !== null) throw new EditFail('exists', to);
      const out = applyHunks(before, sec.hunks, strict, from);
      tree.now.set(from, null);
      tree.now.set(to, out);
      return { old: from, next: to };
    };
  }
  const p = oldPath ?? '';
  return (tree) => {
    if (!safePath(p)) throw new EditFail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new EditFail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// Read the patch as unified diffs. Sections start at a `diff --git` line or
// at a `--- ` line followed by a `+++ ` line; outside bodies, lines that are
// not part of a section header are ignored.
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_RE.exec(line);
      if (m === null) throw new ParseErr(i + 1);
      const sec: UniSection = { isCreate: false, isDelete: false, hunks: [] };
      sec.diffOld = m[1];
      sec.diffNew = m[2];
      i = parseUniSection(lines, i + 1, sec, strict, edits);
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: UniSection = { isCreate: false, isDelete: false, hunks: [] };
      i = parseUniSection(lines, i, sec, strict, edits);
      continue;
    }
    if (line.startsWith('@@')) throw new ParseErr(i + 1);
    i++;
  }
  return edits;
}

// ------------------------------------------------------- search-replace ---

// One SEARCH/REPLACE block: old lines empty creates the file, otherwise the
// file exists and the old lines occur at their tier exactly once.
function makeSREdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    const f = splitText(before);
    const found = firstTier(f.lines, old, strict, 0);
    if (found === null) throw new EditFail('no-match', path);
    if (found.occ.length > 1) throw new EditFail('ambiguous', path);
    const at = found.occ[0]!;
    const rep = replacement(f.lines, at, found.tier, old, nw, nw.map(() => null));
    f.lines.splice(at, old.length, ...rep);
    tree.now.set(path, joinLines(f));
  };
}

// Read the patch as SEARCH/REPLACE blocks. The path is the nearest line
// before the SEARCH line, after the previous block's REPLACE line (or the
// start of the patch), that is not blank and does not start with three
// backticks; with no such line a block takes the previous block's path.
function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseErr(s + 1);
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new ParseErr(s + 1);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseErr(s + 1);
    edits.push(makeSREdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ------------------------------------------------------------------ v4a ---

interface V4Chunk {
  anchor: string | null;
  lines: BodyLine[];
  eof: boolean;
}

// Apply one Update File section's chunks in order to a file's text, with a
// cursor that starts at line 0 and moves to just after the lines written.
function applyV4Chunks(text: string, chunks: V4Chunk[], strict: boolean, path: string): string {
  const f = splitText(text);
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let foundAt = -1;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        for (let i = cursor; i < f.lines.length; i++) {
          if (tierKey(f.lines[i]!, t) === tierKey(ch.anchor, t)) {
            foundAt = i;
            break;
          }
        }
        if (foundAt >= 0) break;
      }
      if (foundAt < 0) throw new EditFail('no-match', path);
      cursor = foundAt + 1;
    }
    const { o, n, nFrom } = splitBody(ch.lines);
    if (o.length === 0) {
      const at = ch.eof ? f.lines.length : cursor;
      f.lines.splice(at, 0, ...n);
      cursor = at + n.length;
      continue;
    }
    if (ch.eof) {
      const at = f.lines.length - o.length;
      if (at < cursor) throw new EditFail('no-match', path);
      const tiers = strict ? [0] : [0, 1, 2];
      let tier = -1;
      for (const t of tiers) {
        let ok = true;
        for (let j = 0; j < o.length; j++) {
          if (tierKey(f.lines[at + j]!, t) !== tierKey(o[j]!, t)) {
            ok = false;
            break;
          }
        }
        if (ok) {
          tier = t;
          break;
        }
      }
      if (tier < 0) throw new EditFail('no-match', path);
      const rep = replacement(f.lines, at, tier, o, n, nFrom);
      f.lines.splice(at, o.length, ...rep);
      cursor = at + rep.length;
      continue;
    }
    const found = firstTier(f.lines, o, strict, cursor);
    if (found === null) throw new EditFail('no-match', path);
    const at = found.occ[0]!;
    const rep = replacement(f.lines, at, found.tier, o, n, nFrom);
    f.lines.splice(at, o.length, ...rep);
    cursor = at + rep.length;
  }
  return joinLines(f);
}

// Turn one parsed Update File section into its edit.
function makeV4UpdateEdit(path: string, moveTo: string | null, chunks: V4Chunk[], strict: boolean, updateLine: number): Edit {
  return (tree) => {
    if (!safePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const out = applyV4Chunks(before, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      return { old: path, next: moveTo };
    }
    tree.now.set(path, out);
  };
}

// Parse one V4A section's raw lines (blank lines at the end already
// stripped) and append its edit. `start` is the index of the section's
// header line, used for the no-chunk parse error.
function parseV4Section(kind: string, path: string, raw: { text: string; idx: number }[], start: number, strict: boolean, edits: Edit[]): void {
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const e of raw) {
      if (e.text === '') fileLines.push('');
      else if (e.text.startsWith('+')) fileLines.push(e.text.slice(1));
      else throw new ParseErr(e.idx + 1);
    }
    edits.push((tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    });
    return;
  }
  if (kind === 'delete') {
    if (raw.length > 0) throw new ParseErr(raw[0]!.idx + 1);
    edits.push((tree) => {
      if (!safePath(path)) throw new EditFail('unsafe', path);
      if (tree.get(path) === null) throw new EditFail('missing', path);
      tree.now.set(path, null);
    });
    return;
  }
  let moveTo: string | null = null;
  const chunks: V4Chunk[] = [];
  let cur: V4Chunk | null = null;
  for (let k = 0; k < raw.length; k++) {
    const e = raw[k]!;
    const line = e.text;
    if (k === 0 && line.startsWith('*** Move to: ')) {
      moveTo = line.slice(13).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      const anchor = line.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, lines: [], eof: false };
      chunks.push(cur);
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, lines: [], eof: false };
        chunks.push(cur);
      }
      cur.eof = true;
      cur = null;
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur === null) {
        cur = { anchor: null, lines: [], eof: false };
        chunks.push(cur);
      }
      cur.lines.push(bodyLineOf(line));
      continue;
    }
    throw new ParseErr(e.idx + 1);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseErr(start + 1);
  edits.push(makeV4UpdateEdit(path, moveTo, chunks, strict, start));
}

const V4_ADD = '*** Add File: ';
const V4_DELETE = '*** Delete File: ';
const V4_UPDATE = '*** Update File: ';

function isV4SectionStart(line: string): boolean {
  return line.startsWith(V4_ADD) || line.startsWith(V4_DELETE) || line.startsWith(V4_UPDATE);
}

// Read the patch as a V4A patch.
function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    let kind: string | null = null;
    let path = '';
    if (line.startsWith(V4_ADD)) {
      kind = 'add';
      path = line.slice(V4_ADD.length).trim();
    } else if (line.startsWith(V4_DELETE)) {
      kind = 'delete';
      path = line.slice(V4_DELETE.length).trim();
    } else if (line.startsWith(V4_UPDATE)) {
      kind = 'update';
      path = line.slice(V4_UPDATE.length).trim();
    } else {
      throw new ParseErr(i + 1);
    }
    const start = i;
    i++;
    const raw: { text: string; idx: number }[] = [];
    while (i < last && !isV4SectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, idx: i });
      i++;
    }
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();
    parseV4Section(kind, path, raw, start, strict, edits);
  }
  return edits;
}

// ------------------------------------------------------------------ run ---

// Compare two paths in byte order (UTF-8).
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines, strict);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new ParseErr(1);
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  const moves: { old: string; next: string }[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = edit(tree);
      if (m !== undefined) moves.push(m);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // One row per path whose state changed. A move whose old path existed
  // before and does not after, and whose new path did not exist before and
  // does after, prints as one `R` row sorted by the new path instead of a
  // `D` row and an `A` row.
  const changed = [...tree.now.keys()].filter((p) => tree.now.get(p) !== tree.original(p));
  const rows: { key: string; text: string }[] = [];
  const merged = new Set<string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.next) === null && tree.now.get(m.next) !== null) {
      rows.push({ key: m.next, text: `R ${m.old} -> ${m.next}` });
      merged.add(m.old);
      merged.add(m.next);
    }
  }
  for (const p of changed) {
    if (merged.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    for (const p of [...changed].sort(byteCompare)) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this
  // file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
