// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful edit performed, as [old, new] pairs. */
  readonly moves: Array<[string, string]> = [];
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

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file's lines under its own line break, with whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.final ? doc.br : '');
}

/** A line compared at a matching tier (SPEC.md section 5). */
function norm(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in file at tier. */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + o.length <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (norm(file[i + j]!, tier) !== norm(o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs, with its positions, or null. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t += 1) {
    const pos = occurrences(file, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/**
 * The lines that replace a match: context lines (nToO >= 0) are the file's own
 * matched lines; at tier 2 every other line is re-indented from O's first
 * line's leading whitespace to the file's first matched line's.
 */
function buildN(file: string[], pos: number, o: string[], n: string[], nToO: number[], tier: number): string[] {
  if (o.length === 0) return [...n];
  const p = leadingWs(o[0]!);
  const f = leadingWs(file[pos]!);
  return n.map((ln, i) => {
    const oi = nToO[i]!;
    if (oi >= 0) return file[pos + oi]!;
    if (tier === 2 && ln !== '' && ln.trim() !== '' && ln.startsWith(p)) return f + ln.slice(p.length);
    return ln;
  });
}

function replaceAt(doc: FileDoc, pos: number, oLen: number, nLines: string[]): FileDoc {
  return { lines: [...doc.lines.slice(0, pos), ...nLines, ...doc.lines.slice(pos + oLen)], br: doc.br, final: doc.final };
}

interface Hunk {
  a: number;
  o: string[];
  n: string[];
  nToO: number[];
  plus: string[];
  noEol: boolean;
  noEolPlus: boolean;
}

interface RawSection {
  dashOld: string | null | undefined;
  dashNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitOld: string | undefined;
  gitNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+)\s+b\/(\S+)\s*$/;

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** The path a `--- `/`+++ ` line names: null for /dev/null. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  return t === '/dev/null' ? null : stripAB(t);
}

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: Array<{ kind: string; text: string }> = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('diff --git ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ kind: l === '' ? ' ' : l[0]!, text: l === '' ? '' : l.slice(1) });
      j += 1;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '') body.pop();
  const o: string[] = [];
  const n: string[] = [];
  const nToO: number[] = [];
  const plus: string[] = [];
  for (const b of body) {
    if (b.kind === ' ') { o.push(b.text); n.push(b.text); nToO.push(o.length - 1); }
    else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') { n.push(b.text); nToO.push(-1); plus.push(b.text); }
  }
  const lastNoEol = (wantPlus: boolean): boolean => {
    for (let k = body.length - 1; k >= 0; k -= 1) {
      const b = body[k]!;
      if (b.kind === ' ' || b.kind === '+') {
        if (wantPlus && b.kind !== '+') continue;
        return k + 1 < body.length && body[k + 1]!.kind === '\\';
      }
    }
    return false;
  };
  return { hunk: { a, o, n, nToO, plus, noEol: lastNoEol(false), noEolPlus: lastNoEol(true) }, next: j };
}

function parseUnified(lines: string[]): RawSection[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let headerDone = false;
  let i = 0;
  const fresh = (): RawSection => ({ dashOld: undefined, dashNew: undefined, renameFrom: undefined, renameTo: undefined, gitOld: undefined, gitNew: undefined, newFile: false, deletedFile: false, hunks: [] });
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      headerDone = false;
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      headerDone = true;
      i = next;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || headerDone) {
        cur = fresh();
        sections.push(cur);
        headerDone = false;
      }
      cur.dashOld = headerPath(line);
      cur.dashNew = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) cur.dashNew = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => {
    const oldP = sec.dashOld !== undefined ? sec.dashOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld ?? null;
    const newP = sec.dashNew !== undefined ? sec.dashNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew ?? null;
    const isCreate = sec.newFile || oldP === null;
    const isDelete = !isCreate && (sec.deletedFile || newP === null);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    return (tree: Tree): void => {
      if (typeof oldP === 'string' && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (typeof newP === 'string' && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate) {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let noEol = false;
        for (const h of sec.hunks) {
          plus.push(...h.plus);
          if (h.plus.length > 0) noEol = h.noEolPlus;
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (oldP === null) return;
      if (isDelete) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (isMove && newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
      let doc = parseFile(text);
      let d = 0;
      for (const h of sec.hunks) {
        if (h.o.length === 0) {
          let at = h.a + d;
          if (at < 0) at = 0;
          if (at > doc.lines.length) at = doc.lines.length;
          const atEnd = at === doc.lines.length;
          doc = replaceAt(doc, at, 0, [...h.n]);
          if (atEnd) doc = { ...doc, final: !h.noEol };
          d += h.n.length;
          continue;
        }
        const found = findTier(doc.lines, h.o, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const q of found.pos) {
          const dist = Math.abs(q - target);
          if (dist < bestDist) { best = q; bestDist = dist; }
        }
        const newN = buildN(doc.lines, best, h.o, h.n, h.nToO, found.tier);
        const runsToEnd = best + h.o.length === doc.lines.length;
        doc = replaceAt(doc, best, h.o.length, newN);
        if (runsToEnd) doc = { ...doc, final: !h.noEol };
        d += h.n.length - h.o.length;
      }
      const out = renderFile(doc);
      if (isMove && newP !== null) {
        tree.now.set(newP, out);
        tree.now.set(oldP, null);
        tree.moves.push([oldP, newP]);
      } else {
        tree.now.set(oldP, out);
      }
    };
  });
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const doc = parseFile(text);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const newN = buildN(doc.lines, pos, oldLines, newLines, newLines.map(() => -1), found.tier);
    tree.now.set(path, renderFile(replaceAt(doc, pos, oldLines.length, newN)));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  for (let si = 0; si < lines.length; si += 1) {
    if (lines[si]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let eq = -1;
    for (let j = si + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    let path: string | null = null;
    for (let j = si - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${si + 1}`);
    prevPath = path;
    prevEnd = rep + 1;
    edits.push(srEdit(path, lines.slice(si + 1, eq), lines.slice(eq + 1, rep), strict));
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree: Tree): void => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let doc = parseFile(text);
    let cursor = 0;
    const maxTier = strict ? 0 : 2;
    for (const ch of chunks) {
      const o: string[] = [];
      const n: string[] = [];
      const nToO: number[] = [];
      for (const l of ch.body) {
        if (l.startsWith(' ')) { o.push(l.slice(1)); n.push(l.slice(1)); nToO.push(o.length - 1); }
        else if (l.startsWith('-')) o.push(l.slice(1));
        else if (l.startsWith('+')) { n.push(l.slice(1)); nToO.push(-1); }
        else { o.push(''); n.push(''); nToO.push(o.length - 1); }
      }
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundIdx = -1;
        for (let t = 0; t <= maxTier && foundIdx < 0; t += 1) {
          for (let k = cursor; k < doc.lines.length; k += 1) {
            if (norm(doc.lines[k]!, t) === norm(ch.anchor, t)) { foundIdx = k; break; }
          }
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (o.length === 0) {
        const at = ch.eof ? doc.lines.length : cursor;
        doc = replaceAt(doc, at, 0, [...n]);
        cursor = at + n.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      for (let t = 0; t <= maxTier; t += 1) {
        const positions = occurrences(doc.lines, o, t).filter((p) => p >= cursor);
        if (ch.eof) {
          const endPos = doc.lines.length - o.length;
          if (endPos >= cursor && positions.includes(endPos)) { found = { tier: t, pos: endPos }; break; }
        } else if (positions.length > 0) {
          found = { tier: t, pos: positions[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const newN = buildN(doc.lines, found.pos, o, n, nToO, found.tier);
      doc = replaceAt(doc, found.pos, o.length, newN);
      cursor = found.pos + newN.length;
    }
    const out = renderFile(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+')) { fileLines.push(l.slice(1)); i += 1; }
        else if (l === '') { fileLines.push(''); i += 1; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      i += 1;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (blank(l)) { i += 1; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree: Tree): void => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (seenChunk) {
              if (l === '') { i += 1; continue; }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            seenChunk = true;
          }
          cur.body.push(l);
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          seenChunk = true;
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0 && lc.body[lc.body.length - 1]!.trim() === '') lc.body.pop();
        if (lc.body.length === 0 && lc.anchor === null && !lc.eof) chunks.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
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
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row { key: string; line: string }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      const di = rows.findIndex((r) => r.line === `D ${oldP}`);
      const ai = rows.findIndex((r) => r.line === `A ${newP}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
