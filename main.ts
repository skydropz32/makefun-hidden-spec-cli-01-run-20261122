// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads four AI edit formats (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) and applies
// them to a tree of text files, all or nothing: every file is changed or nothing is. Line numbers in a unified diff
// are not trusted blindly (three-tier fuzzy matching finds the named lines even when whitespace or indentation has
// drifted); a file is only written when every edit succeeds.
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

/** Split a file's text into its line break, its lines, and whether it ends with a break (SPEC.md section 3). */
function splitText(text: string): { br: string; lines: string[]; final: boolean } {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function joinText(br: string, lines: string[], final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
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

/** An edit: applies itself to the tree; returns the (old, new) move it made, when it moved a file. */
type Edit = (tree: Tree) => [string, string] | void;

/** One line of N: a context line (written as the file's own matched line) or an added line. oIdx is the context
 *  line's index in O, or -1 for an added line. */
interface NItem {
  ctx: boolean;
  text: string;
  oIdx: number;
}

interface Hunk {
  a: number;
  o: string[];
  n: NItem[];
  noBreakAtEnd: boolean;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NItem[];
}

/* ---- Section 5: matching lines at three tiers ---- */

function matchLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  const t = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return t(a) === t(b);
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Positions where O occurs in `lines` at `tier`, at or after `from` (occurrences may overlap). */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!matchLine(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2) at which O occurs at or after `from`, and its positions there; null when none. */
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from = 0,
): { tier: number; positions: number[] } | null {
  if (o.length === 0) return null;
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const pos = occurrences(lines, o, tier, from);
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}

/** Build N's lines as written into the file: a context line is the file's own matched line, never the patch's;
 *  at tier 2 every other line is re-indented (O's first line's leading whitespace P replaced by the file's first
 *  matched line's leading whitespace F, when the line starts with P and is not empty or only whitespace). */
function mapN(nItems: NItem[], fileLines: string[], pos: number, tier: number, oLines: string[]): string[] {
  const out: string[] = [];
  const f = fileLines[pos] !== undefined ? leadingWs(fileLines[pos]!) : '';
  const p = oLines.length > 0 ? leadingWs(oLines[0]!) : '';
  for (const it of nItems) {
    if (it.ctx) {
      out.push(fileLines[pos + it.oIdx]!);
    } else if (tier === 2) {
      const t = it.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(it.text);
    }
  }
  return out;
}

/* ---- Section 6: unified diffs ---- */

/** Build a hunk from its body lines (trailing empty lines already stripped). */
function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NItem[] = [];
  let lastCtxOrPlus = -1;
  body.forEach((bl, bi) => {
    if (bl === '' || bl.startsWith(' ')) {
      const text = bl === '' ? '' : bl.slice(1);
      o.push(text);
      n.push({ ctx: true, text, oIdx: o.length - 1 });
      lastCtxOrPlus = bi;
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ ctx: false, text: bl.slice(1), oIdx: -1 });
      lastCtxOrPlus = bi;
    }
    // a `\` line refers to the body line before it; it only affects noBreakAtEnd below.
  });
  const noBreakAtEnd =
    lastCtxOrPlus >= 0 &&
    body[lastCtxOrPlus + 1] !== undefined &&
    body[lastCtxOrPlus + 1]!.startsWith('\\');
  return { a, o, n, noBreakAtEnd };
}

/** Apply a section's hunks in order to `initialText` (null: a creation, starting from an empty file). */
function applyHunks(hunks: Hunk[], path: string, strict: boolean, initialText: string | null): string {
  const { br, lines, final: origFinal } = splitText(initialText ?? '');
  let final = origFinal;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const repl = mapN(h.n, lines, at, 0, h.o);
      const touchesEnd = at === lines.length;
      lines.splice(at, 0, ...repl);
      if (touchesEnd) final = !h.noBreakAtEnd;
      d += h.n.length;
    } else {
      const found = findTier(lines, h.o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of found.positions) {
        const dd = Math.abs(p - target);
        if (dd < best) {
          best = dd;
          pos = p;
        }
      }
      const touchesEnd = pos + h.o.length === lines.length;
      const repl = mapN(h.n, lines, pos, found.tier, h.o);
      lines.splice(pos, h.o.length, ...repl);
      if (touchesEnd) final = !h.noBreakAtEnd;
      d += h.n.length - h.o.length;
    }
  }
  return joinText(br, lines, final);
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = sec.newFile || oldP === null;
    const isDelete = !isCreate && (sec.deletedFile || newP === null);
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      tree.now.set(newP, applyHunks(sec.hunks, newP, strict, null));
      return undefined;
    }
    if (isDelete) {
      if (oldP === null) throw new Fail('unsafe', '');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return undefined;
    }
    if (oldP === null || newP === null) throw new Fail('unsafe', '');
    const isMove = oldP !== newP;
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
    const before = tree.get(oldP)!;
    const text = applyHunks(sec.hunks, oldP, strict, before);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP, text);
      return [oldP, newP];
    }
    tree.now.set(oldP, text);
    return undefined;
  };
}

/** The path on a `--- ` or `+++ ` line: the text after the four characters, up to the first tab, with surrounding
 *  spaces removed; `/dev/null` means no file; a leading `a/` or `b/` is removed. */
function parsePathLine(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Sec {
    diffOld: string | null;
    diffNew: string | null;
    dashOld: string | null;
    dashNew: string | null;
    lonePlus: string | null;
    renameFrom: string | null;
    renameTo: string | null;
    newFile: boolean;
    deletedFile: boolean;
    hasDashPair: boolean;
    hunks: Hunk[];
  }
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const sections: Sec[] = [];
  let cur: Sec | null = null;
  const startSection = (): Sec => {
    const s: Sec = {
      diffOld: null,
      diffNew: null,
      dashOld: null,
      dashNew: null,
      lonePlus: null,
      renameFrom: null,
      renameTo: null,
      newFile: false,
      deletedFile: false,
      hasDashPair: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHeader.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith('@@')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push(buildHunk(a, body));
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0 || cur.hasDashPair) {
        const s = startSection();
        s.dashOld = parsePathLine(line);
        s.dashNew = parsePathLine(lines[i + 1]!);
        s.hasDashPair = true;
      } else {
        cur.dashOld = parsePathLine(line);
        cur.dashNew = parsePathLine(lines[i + 1]!);
        cur.hasDashPair = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // inside a section's header
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) {
        cur.lonePlus = parsePathLine(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.hasDashPair ? s.dashOld : s.renameFrom ?? s.diffOld;
    const newP = s.hasDashPair ? s.dashNew : s.lonePlus ?? s.renameTo ?? s.diffNew;
    if (oldP === null && newP === null) continue;
    edits.push(
      uniEdit(
        { oldPath: oldP, newPath: newP, newFile: s.newFile, deletedFile: s.deletedFile, hunks: s.hunks },
        strict,
      ),
    );
  }
  return edits;
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinText('\n', newLines, true));
      return undefined;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { br, lines, final } = splitText(before);
    const found = findTier(lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const repl = mapN(
      newLines.map((t) => ({ ctx: false, text: t, oIdx: -1 })),
      lines,
      pos,
      found.tier,
      oldLines,
    );
    lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinText(br, lines, final));
    return undefined;
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastReplace = -1;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > lastReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    let repIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '<<<<<<< SEARCH') break;
      if (eqIdx < 0) {
        if (l === '=======') eqIdx = j;
      } else if (l === '>>>>>>> REPLACE') {
        repIdx = j;
        break;
      }
    }
    if (eqIdx < 0 || repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    lastReplace = repIdx;
    i = repIdx + 1;
  }
  return edits;
}

/* ---- Section 8: V4A patches ---- */

function buildV4aChunk(anchor: string | null, eof: boolean, body: string[]): V4aChunk {
  const o: string[] = [];
  const n: NItem[] = [];
  for (const bl of body) {
    if (bl === '' || bl.startsWith(' ')) {
      const text = bl === '' ? '' : bl.slice(1);
      o.push(text);
      n.push({ ctx: true, text, oIdx: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ ctx: false, text: bl.slice(1), oIdx: -1 });
    }
  }
  return { anchor, eof, o, n };
}

function v4aAddEdit(path: string, content: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, joinText('\n', content, true));
    return undefined;
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
    return undefined;
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { br, lines, final } = splitText(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const a = findTier(lines, [ch.anchor], strict, cursor);
        if (!a) throw new Fail('no-match', path);
        cursor = a.positions[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        const repl = mapN(ch.n, lines, at, 0, ch.o);
        lines.splice(at, 0, ...repl);
        cursor = at + repl.length;
      } else {
        const found = findTier(lines, ch.o, strict, cursor);
        if (!found) throw new Fail('no-match', path);
        let pos: number | null = null;
        for (const p of found.positions) {
          if (ch.eof && p + ch.o.length !== lines.length) continue;
          pos = p;
          break;
        }
        if (pos === null) throw new Fail('no-match', path);
        const repl = mapN(ch.n, lines, pos, found.tier, ch.o);
        lines.splice(pos, ch.o.length, ...repl);
        cursor = pos + repl.length;
      }
    }
    const text = joinText(br, lines, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      return [path, moveTo];
    }
    tree.now.set(path, text);
    return undefined;
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const raw: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('+') || l === '') {
          raw.push(l);
          i++;
        } else break;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!)) raw.pop();
      const content = raw.map((l) => (l.startsWith('+') ? l.slice(1) : ''));
      edits.push(v4aAddEdit(path, content));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let startedChunk = false;
      let curChunk: { anchor: string | null; eof: boolean; body: string[] } | null = null;
      const flushChunk = (): void => {
        if (curChunk === null) return;
        const body = [...curChunk.body];
        while (body.length > 0 && blank(body[body.length - 1]!)) body.pop();
        chunks.push(buildV4aChunk(curChunk.anchor, curChunk.eof, body));
        curChunk = null;
      };
      while (i < last) {
        const l = lines[i]!;
        if (l.startsWith('@@')) {
          flushChunk();
          const anchor = l.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          startedChunk = true;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${i + 1}`);
          curChunk.eof = true;
          flushChunk();
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (curChunk === null) {
            if (startedChunk) throw new Exit2(`error: parse ${i + 1}`);
            curChunk = { anchor: null, eof: false, body: [] };
            startedChunk = true;
          }
          curChunk.body.push(l);
          i++;
          continue;
        }
        if (
          l.startsWith('*** Add File: ') ||
          l.startsWith('*** Delete File: ') ||
          l.startsWith('*** Update File: ')
        ) {
          break;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flushChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/* ---- Section 4: detecting the format ---- */

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  )
    return 'unified';
  return null;
}

/* ---- Section 9: JSON edits ---- */

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
      return undefined;
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
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
      return undefined;
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
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
      return undefined;
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

/* ---- Sections 1, 2 and 10: invocation, output, order and atomicity ---- */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Array<[string, string]> = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      const m = edit(tree);
      if (m) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0)
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  const recs: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was === null) recs.push({ key: p, line: `A ${p}` });
    else if (now === null) recs.push({ key: p, line: `D ${p}` });
    else recs.push({ key: p, line: `M ${p}` });
  }
  for (const [oldP, newP] of moves) {
    if (
      tree.original(oldP) !== null &&
      tree.get(oldP) === null &&
      tree.original(newP) === null &&
      tree.get(newP) !== null
    ) {
      const di = recs.findIndex((r) => r.line === `D ${oldP}`);
      const ai = recs.findIndex((r) => r.line === `A ${newP}`);
      if (di >= 0 && ai >= 0) {
        recs.splice(di, 1);
        const ai2 = recs.findIndex((r) => r.line === `A ${newP}`);
        recs.splice(ai2, 1);
        recs.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      }
    }
  }
  recs.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = recs.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
