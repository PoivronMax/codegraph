/**
 * Offset-preserving source rewrites that let tree-sitter-cangjie 1.1.0 parse
 * real Cangjie it otherwise turns into ERROR nodes. Every rewrite keeps the
 * byte length and every newline, so node positions stay correct.
 *
 * Measured on cangjie_stdx / the std library / fountain, the gaps that cost
 * the most symbols were:
 *   - organization-qualified packages: `package fountain::f_http` and
 *     `import fountain::f_base.*` (every file of an org-qualified module
 *     lost its package);
 *   - bracketed annotations: `@Deprecated[message: "…"]`,
 *     `@Annotation[target: [A, B]]` — the grammar knows only bare `@Name`;
 *   - abstract properties, `prop size: Int64` with no accessor body (an
 *     interface's properties) — the grammar requires the body;
 *   - byte literals `b'"'`, integer suffixes written `0_i32`;
 *   - a string literal used as a receiver: `"null".toArray()`;
 *   - nested block comments `/* … /* … *\/ … *\/`.
 *
 * Rewrites only ever touch code — a lexer pass first marks the bytes that
 * are inside strings and comments.
 */

/** 0 = code, 1 = string, 2 = comment. */
type Mask = Uint8Array;

const IDENT = /[A-Za-z0-9_]/;

/**
 * Body-less properties rewritten to body-less functions, by the rewritten
 * source: the extractor reads this back to emit them as `property` nodes.
 * preParse is deterministic and running it again on its own output rewrites
 * nothing, so entries are only ever added; the map is capped to the most
 * recent sources.
 */
const REWRITTEN_PROPS = new Map<string, Set<number>>();
const REWRITTEN_PROPS_CAP = 32;

/** Start offsets of the declarations preParse rewrote from `prop` to `func`. */
export function cangjieRewrittenProps(source: string): ReadonlySet<number> | undefined {
  return REWRITTEN_PROPS.get(source);
}

/** Lex `src` into a code / string / comment mask. Interpolations `${…}` are code. */
function lex(src: string): { mask: Mask; strings: [number, number][]; nestedCommentMarks: number[] } {
  const mask = new Uint8Array(src.length);
  const strings: [number, number][] = [];
  const nestedCommentMarks: number[] = [];
  const n = src.length;

  // Scan code from `i` until an unmatched `}` (when inInterp) or EOF.
  const scanCode = (start: number, inInterp: boolean): number => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = src[i]!;
      if (c === '/' && src[i + 1] === '/') {
        const end = src.indexOf('\n', i);
        const stop = end < 0 ? n : end;
        mask.fill(2, i, stop);
        i = stop;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i = scanBlockComment(i);
        continue;
      }
      if (c === '#' || c === '"' || c === "'") {
        const end = scanString(i);
        if (end > i) {
          i = end;
          continue;
        }
      }
      if (inInterp) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) return i;
          depth--;
        }
      }
      i++;
    }
    return i;
  };

  const scanBlockComment = (start: number): number => {
    let i = start + 2;
    let depth = 1;
    while (i < n && depth > 0) {
      if (src[i] === '/' && src[i + 1] === '*') {
        nestedCommentMarks.push(i);
        depth++;
        i += 2;
      } else if (src[i] === '*' && src[i + 1] === '/') {
        depth--;
        if (depth > 0) nestedCommentMarks.push(i);
        i += 2;
      } else i++;
    }
    mask.fill(2, start, Math.min(i, n));
    return i;
  };

  // A string literal starting at `start`: `"…"`, `'…'`, `"""…"""`, `'''…'''`,
  // raw `#"…"#` / `##'…'##`. Returns the end offset, or `start` if none.
  const scanString = (start: number): number => {
    let i = start;
    let hashes = 0;
    while (src[i] === '#') {
      hashes++;
      i++;
    }
    const q = src[i];
    if (q !== '"' && q !== "'") return start;
    if (hashes > 0) {
      const close = q + '#'.repeat(hashes);
      const end = src.indexOf(close, i + 1);
      const stop = end < 0 ? n : end + close.length;
      mask.fill(1, start, stop);
      strings.push([start, stop]);
      return stop;
    }
    const triple = src[i + 1] === q && src[i + 2] === q;
    i += triple ? 3 : 1;
    const segStart = start;
    while (i < n) {
      const c = src[i]!;
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '$' && src[i + 1] === '{') {
        const close = scanCode(i + 2, true);
        i = close + 1;
        continue;
      }
      if (triple ? c === q && src[i + 1] === q && src[i + 2] === q : c === q) {
        i += triple ? 3 : 1;
        break;
      }
      if (!triple && c === '\n') break; // unterminated single-line string
      i++;
    }
    // The whole literal, interpolations included, counts as string: no
    // rewrite reaches into an interpolation (comments inside keep their mark).
    for (let k = segStart; k < Math.min(i, n); k++) if (mask[k] === 0) mask[k] = 1;
    strings.push([segStart, Math.min(i, n)]);
    return Math.min(i, n);
  };

  scanCode(0, false);
  return { mask, strings, nestedCommentMarks };
}

function blank(out: string[], from: number, to: number): void {
  for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
}

const PROP_LINE =
  /^([ \t]*)((?:(?:public|private|protected|internal|open|mut|static|override|redef|abstract|sealed|unsafe)[ \t]+)*)prop([ \t]+)([A-Za-z_]\w*)[ \t]*:([^\n{=]*?)[ \t]*$/;

export function preParseCangjie(source: string): string {
  // Cheap gate: nothing to do for sources with none of the trigger shapes.
  if (!/::|@\w+\[|\bprop\b|b'|_[iuf]\d|["']\s*\.|\/\*/.test(source)) return source;

  const { mask, strings, nestedCommentMarks } = lex(source);
  const out = source.split('');
  const isCode = (i: number): boolean => mask[i] === 0;

  // Nested block comments: drop the inner delimiters so the comment is flat.
  for (const at of nestedCommentMarks) {
    out[at] = ' ';
    out[at + 1] = ' ';
  }

  // Byte literals `b'x'` → `0` (an integer literal of the same width), and
  // string receivers `"x".m()` → an identifier of the same width.
  for (const [start, end] of strings) {
    const prev = source[start - 1];
    const prev2 = source[start - 2];
    if (prev === 'b' && source[start] === "'" && (!prev2 || !IDENT.test(prev2)) && isCode(start - 1)) {
      out[start - 1] = '0';
      blank(out, start, end);
      continue;
    }
    if (prev && (prev === 'r' || IDENT.test(prev))) continue; // rune literal / prefixed
    const literal = source.slice(start, end);
    if (literal.includes('\n') || !(source[start] === '"' || source[start] === "'")) continue;
    if (source[end] === '.' && /[A-Za-z_]/.test(source[end + 1] ?? '')) {
      out[start] = '_';
      for (let k = start + 1; k < end; k++) out[k] = 's';
    }
  }

  // Bracketed annotations `@Name[…]` → blanks (the declaration they decorate
  // stays). Brackets are matched over code bytes only.
  const annot = /@[A-Za-z_]\w*\[/g;
  let m: RegExpExecArray | null;
  while ((m = annot.exec(source)) !== null) {
    if (!isCode(m.index)) continue;
    let depth = 0;
    let k = m.index + m[0].length - 1;
    for (; k < source.length; k++) {
      if (!isCode(k)) continue;
      if (source[k] === '[') depth++;
      else if (source[k] === ']' && --depth === 0) break;
    }
    if (depth !== 0) continue;
    blank(out, m.index, k + 1);
    annot.lastIndex = k + 1;
  }

  // Integer suffix written with a separator: `0_i32` → `0    `.
  const suffix = /(\d)_([iuf](?:8|16|32|64))\b/g;
  while ((m = suffix.exec(source)) !== null) {
    if (isCode(m.index)) blank(out, m.index + 1, m.index + m[0].length);
  }

  // Line-based rewrites.
  const props = new Set<number>();
  let lineStart = 0;
  while (lineStart <= source.length) {
    const nl = source.indexOf('\n', lineStart);
    const lineEnd = nl < 0 ? source.length : nl;
    const line = source.slice(lineStart, lineEnd);
    const firstCode = lineStart + (line.length - line.trimStart().length);

    if (isCode(firstCode)) {
      // `package org::pkg.sub` / `import org::pkg.*` → `org. pkg…`
      if (/^\s*(?:(?:public|protected|internal|private)\s+)?(?:macro\s+)?(?:package|import)\s/.test(line)) {
        let idx = line.indexOf('::');
        while (idx >= 0) {
          if (isCode(lineStart + idx)) {
            out[lineStart + idx] = '.';
            out[lineStart + idx + 1] = ' ';
          }
          idx = line.indexOf('::', idx + 2);
        }
      }

      // Body-less `prop x: T` → `func x(): T`, shifted into the indentation.
      const pm = PROP_LINE.exec(line);
      if (pm && !nextCodeLineOpensBrace(source, mask, lineEnd)) {
        const mods = pm[2]!.split(/\s+/).filter((w) => w && w !== 'mut');
        const type = pm[5]!.trim();
        const core = `${mods.length ? mods.join(' ') + ' ' : ''}func ${pm[4]}(): ${type}`;
        if (type && core.length <= line.length) {
          const startCol = line.length - core.length;
          for (let k = 0; k < line.length; k++) {
            out[lineStart + k] = k < startCol ? (line[k] === '\t' ? '\t' : ' ') : core[k - startCol]!;
          }
          props.add(lineStart + startCol);
        }
      }
    }
    if (nl < 0) break;
    lineStart = nl + 1;
  }

  const result = out.join('');
  if (props.size > 0) {
    if (REWRITTEN_PROPS.size >= REWRITTEN_PROPS_CAP) {
      const oldest = REWRITTEN_PROPS.keys().next().value;
      if (oldest !== undefined) REWRITTEN_PROPS.delete(oldest);
    }
    REWRITTEN_PROPS.set(result, props);
  }
  return result;
}

/** Whether the next line holding code starts with `{` (an accessor body on its own line). */
function nextCodeLineOpensBrace(source: string, mask: Mask, from: number): boolean {
  for (let k = from; k < source.length; k++) {
    const c = source[k]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    if (mask[k] === 2) continue; // comment
    return c === '{';
  }
  return false;
}
