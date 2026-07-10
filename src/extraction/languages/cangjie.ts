import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Node names follow the vendored Cangjie grammar (Cangjie-SIG/
// tree-sitter-cangjie 1.1.0 — see vendor/tree-sitter-cangjie). The grammar
// declares NO fields: names, bodies, and parameter lists are all plain named
// children (funcName/className/…, block/classBody/…), so this extractor works
// through the resolveName/resolveBody hooks rather than the *Field configs.

/** First DIRECT NAMED child of the given type, or null. Named-only matters:
 * keyword tokens can share a type name with a named node (the `operator`
 * KEYWORD in `operator func +` is an anonymous token of type 'operator',
 * while the named 'operator' child carries the actual symbol `+`). */
function directChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child && child.type === type) return child;
  }
  return null;
}

/** First DIRECT NAMED child among the given types, or null. */
function directChildOf(node: SyntaxNode, types: readonly string[]): SyntaxNode | null {
  for (const child of node.namedChildren) {
    if (child && types.includes(child.type)) return child;
  }
  return null;
}

/**
 * Byte offsets (in the PRE-PARSED source) where preParse blanked a
 * line-leading attribute dot. Written by preParse, read by
 * cangjieCalleeName during the extraction of the SAME file — the extractor
 * runs preParse → parse → walk synchronously per file, so this module-level
 * channel never interleaves across files.
 */
let blankedDotOffsets = new Set<number>();

/**
 * 1-based line → macro-annotation names that preParse blanked off that line.
 * The grammar cannot parse TWO consecutive same-line annotated members
 * (`@Publish var a = 1` newline `@Publish var b = 2` — the second one ERRORs
 * and truncates the class body), while the plain members parse perfectly.
 * preParse blanks the same-line annotation tokens and records them here;
 * collectMacroAnnotations merges them back onto the declaration's node.
 * Same synchronous per-file lifecycle as blankedDotOffsets above.
 */
let sameLineAnnotations = new Map<number, string[]>();

/**
 * 1-based line → the REAL operator symbol preParse substituted away. The
 * grammar's operator rule has no `()` (the call operator), so
 * `operator func ()(): T` cannot parse; preParse swaps the symbol for the
 * same-width `==` and records the truth here for resolveName.
 */
let substitutedOperators = new Map<number, string>();

/**
 * Operator symbols this FILE declares via `operator func <op>` — written by
 * preParse, read by the binary-operator call extraction (tree-sitter.ts).
 * Operator INVOCATIONS (`a == b`) are emitted as call refs only for these:
 * gating on a same-file declaration keeps the ref volume at zero for the
 * overwhelmingly common primitive-operator lines, while covering the pattern
 * that actually occurs (a type defining `==` and comparing itself in the
 * same file). Cross-file operator usage is a documented gap.
 */
let declaredOperators = new Set<string>();

export function cangjieFileDeclaredOperators(): Set<string> {
  return declaredOperators;
}

/**
 * Receiver root of a binary-operator invocation's LEFT operand:
 * 'this' | 'super' | simple identifier | '#expr'.
 */
export function cangjieOperandRoot(node: SyntaxNode, source: string): string {
  const r = unwrapSingle(node);
  if (r.type === 'thisSuperExpression') return getNodeText(r, source).trim();
  if (r.type === 'identifier' || r.type === 'varBindingPattern' || r.type === 'scoped_identifier') {
    const text = getNodeText(r, source).trim();
    if (/^[A-Za-z_]\w*$/.test(text)) return text;
  }
  return '#expr';
}

/** Leftmost name leaf of a postfix chain (its receiver root). */
function chainRoot(expr: SyntaxNode): SyntaxNode | null {
  let n: SyntaxNode | null = expr;
  for (let depth = 0; n && depth < 32; depth++) {
    if (n.type === 'postfixExpression' || n.type === 'atomicVariable') {
      n = n.namedChildren.find((c) => c !== null) ?? null;
      continue;
    }
    return n;
  }
  return null;
}

/**
 * True when a chained `.attr(...)` hangs off a UI-DSL component expression —
 * the chain's root is a CAPITALIZED bare component call/trailing-lambda
 * (`Text("x").fontSize(16)`, `Column { … }.width(100)`), or the root call was
 * itself a preParse-blanked leading-dot attribute (`.padding(1).opacity(2)`).
 * Lowercase fluent chains (`list.map { … }.filter { … }`,
 * `makeBuilder().withX()`) stay ungated and resolve as ordinary calls.
 */
function isAttributeChainReceiver(beforeField: SyntaxNode): boolean {
  if (beforeField.type !== 'postfixExpression') return false;
  const kids = beforeField.namedChildren.filter((c) => c !== null);
  const last = kids[kids.length - 1];
  if (!last || (last.type !== 'callSuffix' && last.type !== 'trailingLambdaExpression')) {
    return false;
  }
  const root = chainRoot(beforeField);
  if (!root) return false;
  if (blankedDotOffsets.has(root.startIndex - 1)) return true;
  const first = root.text.charAt(0);
  return first >= 'A' && first <= 'Z';
}

/**
 * Static callee name of a Cangjie call site, given the expression the call
 * suffix applies to (the named sibling immediately preceding the `callSuffix`
 * or `trailingLambdaExpression` inside the parent `postfixExpression`).
 *
 * The grammar nests suffixes left-associatively — `a.b[i](x)` is
 * postfixExpression(postfixExpression(postfixExpression(a, .b), [i]), (x)) —
 * so the callee is decided by the LAST suffix of the preceding expression:
 *   foo(x)              atomicVariable            → "foo"
 *   obj.method(x)       …ends in fieldAccess      → "method"
 *   x?.start()          …ends in fieldAccess      → "start"
 *   cb?()               …ends in questAccess      → unwrap to "cb"
 *   this(x)             thisSuperExpression       → "init" (ctor delegation)
 *   handlers[i]()       …ends in indexAccess      → none (dynamic target)
 *   f(a)(b)             …ends in callSuffix       → none (curried result)
 *   { => … }()          lambdaExpression          → none (IIFE)
 * Returning undefined emits NO reference — a wrong name would let the
 * resolver link an arbitrary same-named function, worse than no edge.
 */
export function cangjieCalleeName(expr: SyntaxNode | null, source: string): string | undefined {
  for (let depth = 0; expr && depth < 32; depth++) {
    switch (expr.type) {
      case 'varBindingPattern':
      case 'identifier':
      case 'scoped_identifier': {
        const text = getNodeText(expr, source).trim();
        if (!text) return undefined;
        // A callee sitting where preParse blanked a line-leading attribute
        // dot IS a chained UI attribute: emit it dot-prefixed so resolution
        // only ever links it to a decorator-marked attribute helper.
        return blankedDotOffsets.has(expr.startIndex - 1) ? `.${text}` : text;
      }
      case 'atomicVariable':
      case 'fieldAccess': {
        const inner = expr.namedChildren.find((c) => c !== null) ?? null;
        // Generic instantiation (`DefaultPayloadEmitHandler<T>()`) parses as
        // atomicVariable[typeArguments] with the base name an ANONYMOUS token
        // — the unwrap would land on typeArguments and lose the callee.
        if (expr.type === 'atomicVariable' && inner?.type === 'typeArguments') {
          const base = getNodeText(expr, source).split('<')[0]!.trim();
          if (/^[A-Za-z_]\w*$/.test(base)) {
            return blankedDotOffsets.has(expr.startIndex - 1) ? `.${base}` : base;
          }
          return undefined;
        }
        expr = inner;
        continue;
      }
      case 'postfixExpression': {
        const children = expr.namedChildren.filter((c) => c !== null);
        const last = children[children.length - 1] ?? null;
        if (!last) return undefined;
        if (last.type === 'fieldAccess') {
          // `.attr` chained onto a component expression is a UI attribute,
          // not a method call — emit dot-prefixed (hard-gated in resolution).
          const receiver = children.length >= 2 ? children[children.length - 2]! : null;
          if (receiver && isAttributeChainReceiver(receiver)) {
            const name = cangjieCalleeName(last, source);
            return name ? `.${name}` : undefined;
          }
          expr = last;
          continue;
        }
        if (last.type === 'questAccess') {
          // `cb?()` — the `?` is a no-op for naming; unwrap to what precedes it
          expr = children.length >= 2 ? children[children.length - 2]! : null;
          continue;
        }
        if (children.length === 1) {
          expr = last;
          continue;
        }
        // indexAccess / callSuffix / trailingLambdaExpression / literals:
        // the called value is computed — no static name.
        return undefined;
      }
      case 'thisSuperExpression':
        // `this(...)` delegates to another constructor of the SAME class —
        // same-file preference resolves the bare name. `super(...)` targets
        // the parent's ctor; a bare "init" would mis-link to our own, so stay
        // silent there.
        return getNodeText(expr, source).trim() === 'this' ? 'init' : undefined;
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * Callee name PLUS the receiver root of a Cangjie call site — the resolution
 * side uses the receiver to gate method candidates by type instead of
 * defaulting to same-file preference (which bound `value.toString()` to
 * whatever `toString` the host file declared).
 *
 * receiver encoding:
 *   'this' / 'super'   explicit self / supertype dispatch
 *   'this.<field>'     field receiver (`this.progressBar.getPathCmd()`)
 *   '<identifier>'     simple-name receiver (`out.append(x)`) — a local,
 *                      parameter, field, or a TYPE name (static call)
 *   '#expr'            computed receiver (chained call, index, literal…)
 *   undefined          bare call (`helper()`) — implicit this or free function
 */
export function cangjieCallInfo(
  expr: SyntaxNode | null,
  source: string,
): { name: string; receiver?: string } | undefined {
  const name = cangjieCalleeName(expr, source);
  if (!name) return undefined;
  if (name.startsWith('.')) return { name }; // UI attribute chain — hard-gated elsewhere
  if (!expr) return { name };
  if (expr.type === 'thisSuperExpression') {
    // `this(...)` ctor delegation — scope to the enclosing type's own inits.
    return { name, receiver: 'this' };
  }
  const receiver = classifyReceiver(expr, source);
  return receiver ? { name, receiver } : { name };
}

/** Unwrap single-child postfix/atomic wrappers to the meaningful node. */
function unwrapSingle(node: SyntaxNode): SyntaxNode {
  let n = node;
  for (let depth = 0; depth < 8; depth++) {
    if (n.type === 'postfixExpression' || n.type === 'atomicVariable') {
      const kids = n.namedChildren.filter((c) => c !== null);
      if (kids.length === 1) {
        n = kids[0]!;
        continue;
      }
    }
    break;
  }
  return n;
}

function classifyReceiver(expr: SyntaxNode, source: string): string | undefined {
  if (expr.type !== 'postfixExpression') return undefined; // bare identifier call
  const kids = expr.namedChildren.filter((c) => c !== null);
  const last = kids[kids.length - 1];
  if (!last || last.type !== 'fieldAccess') return undefined; // not a method-call shape
  if (kids.length !== 2) return '#expr';
  const r = unwrapSingle(kids[0]!);
  if (r.type === 'thisSuperExpression') return getNodeText(r, source).trim();
  if (r.type === 'identifier' || r.type === 'varBindingPattern' || r.type === 'scoped_identifier') {
    const text = getNodeText(r, source).trim();
    return /^[A-Za-z_]\w*$/.test(text) ? text : '#expr';
  }
  if (r.type === 'postfixExpression') {
    const rk = r.namedChildren.filter((c) => c !== null);
    const rLast = rk[rk.length - 1];
    if (
      rk.length === 2 &&
      rLast?.type === 'fieldAccess' &&
      unwrapSingle(rk[0]!).type === 'thisSuperExpression' &&
      getNodeText(unwrapSingle(rk[0]!), source).trim() === 'this'
    ) {
      const field = getNodeText(rLast, source).replace(/^[\s.]+/, '').trim();
      if (/^[A-Za-z_]\w*$/.test(field)) return `this.${field}`;
    }
    // Immediate-call receiver: `LUDecomposition(this).det()` /
    // `addState(k).addEmit(...)` — record what was called so resolution can
    // type the receiver (constructed type, or the callee's return type).
    if (rk.length === 2 && rLast?.type === 'callSuffix') {
      const base = unwrapSingle(rk[0]!);
      if (base.type === 'identifier' || base.type === 'varBindingPattern' || base.type === 'atomicVariable') {
        const text = getNodeText(base, source).split('<')[0]!.trim();
        if (/^[A-Za-z_]\w*$/.test(text)) {
          return /^[A-Z]/.test(text) ? `#new:${text}` : `#call:${text}`;
        }
      }
    }
  }
  return '#expr';
}

/**
 * Macro annotations (`@Entry`, `@Component`, `@State`, `@Builder`, …) parse as
 * `macroExpression` nodes PRECEDING the declaration as siblings — one node per
 * annotation, each carrying a `macroName` child. Walk backwards from the
 * declaration collecting them; stop at the first non-annotation sibling so an
 * earlier declaration's annotations never leak in.
 */
function collectMacroAnnotations(node: SyntaxNode): string[] | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  const siblings = parent.namedChildren;
  const start = node.startIndex;
  let idx = -1;
  for (let i = 0; i < siblings.length; i++) {
    if (siblings[i] && siblings[i]!.startIndex === start) {
      idx = i;
      break;
    }
  }
  const names: string[] = [];
  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i];
    if (!sib || sib.type !== 'macroExpression') break;
    const name = directChild(sib, 'macroName');
    if (name) names.unshift(name.text);
  }
  // Same-line annotations preParse blanked off this declaration's line.
  const inline = sameLineAnnotations.get(node.startPosition.row + 1);
  if (inline) names.unshift(...inline);
  return names.length > 0 ? names : undefined;
}

const NAME_CHILD_TYPES: Record<string, string> = {
  functionDefinition: 'funcName',
  classDefinition: 'className',
  interfaceDefinition: 'interfaceName',
  structDefinition: 'structName',
  enumDefinition: 'enumName',
  propertyDefinition: 'propertyName',
};

const BODY_CHILD_TYPES = [
  'block',
  'classBody',
  'interfaceBody',
  'structBody',
  'enumBody',
  'extendBody',
] as const;

const CLASS_LIKE_KINDS = new Set(['class', 'struct', 'interface', 'enum']);

/**
 * Blank every balanced `Name<...>` generic-argument group at or after `start`
 * (the character after a `<:`). Same-length space replacement; a group whose
 * `<` never balances on this line is left untouched.
 */
function blankSupertypeGenerics(line: string, start: number): string {
  const chars = line.split('');
  let i = start;
  while (i < chars.length) {
    if (/[A-Za-z_0-9]/.test(chars[i]!)) {
      let j = i;
      while (j < chars.length && /[\w]/.test(chars[j]!)) j++;
      if (chars[j] === '<') {
        let depth = 0;
        let k = j;
        for (; k < chars.length; k++) {
          if (chars[k] === '<') depth++;
          else if (chars[k] === '>') {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth === 0) {
          for (let b = j; b <= k; b++) chars[b] = ' ';
          i = k + 1;
          continue;
        }
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return chars.join('');
}

/**
 * Bare name of a declaration's declared USER type (`let repo: Repository` /
 * `prop kind: FilterKind` → the userType's identifier; generics use the head:
 * `Array<FilterUISection>` → Array). Builtin scalar types (Int64, String, …)
 * are keyword-typed nodes, not userType, and return undefined — matching how
 * other languages skip primitive type refs.
 */
function fieldTypeNames(node: SyntaxNode): string[] {
  // The declared type child (`?Config` wraps in prefixType; `Array<T>` is
  // arrayType). Collect the head identifier AND every user type named in the
  // generic arguments — `hourlyForecast: Array<HourlyTempModel>` references
  // HourlyTempModel (builtin scalar types are keyword-typed nodes, never
  // userType, so they never appear here).
  const typeNode = directChildOf(node, ['userType', 'prefixType', 'arrayType', 'tupleType', 'arrowType']);
  if (!typeNode) return [];
  const names: string[] = [];
  const stack: SyntaxNode[] = [typeNode];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur.type === 'userType') {
      const id = directChild(cur, 'identifier');
      if (id && !names.includes(id.text)) names.push(id.text);
    }
    if (cur.type === 'arrayType' && cur.parent === node) {
      // `Array<...>` — the head Array itself is a builtin container; only
      // its arguments matter. (userType heads like Option<T> keep the head.)
    }
    for (const child of cur.namedChildren) {
      if (child) stack.push(child);
    }
  }
  return names;
}

export const cangjieExtractor: LanguageExtractor = {
  // Two constructs the vendored grammar cannot parse (each ERROR can swallow
  // the surrounding class/file — 58 of EUDI's 158 files carried errors, 72 of
  // them from the first shape). Blank them pre-parse, offset-preserving:
  //
  // 1. LINE-LEADING chained attributes — the dominant ArkUI style:
  //        Text("‹")
  //            .fontSize(16)
  //            .onClick({ _ => this.handleBack() })
  //    Blank only the leading DOT: `.padding(top: 8.0)` parses as the plain
  //    call ` padding(top: 8.0)` — named/multi-line arguments and handler
  //    lambdas (`this.handleBack()`) all extract normally, attributed to the
  //    enclosing method. Framework attribute names resolve to nothing and
  //    drop; a user-defined attribute helper resolves to its definition. (No
  //    valid Cangjie parse contains a line-leading `.name` — the grammar has
  //    no rule for it — so this only ever touches broken regions,
  //    raw-string/comment CONTENT aside, which extraction ignores.)
  // 2. Bodiless `prop name: Type` (an interface's abstract property) — the
  //    grammar requires an accessor block. Blank the whole declaration; the
  //    implementing classes carry the real accessors.
  preParse: (source) => {
    blankedDotOffsets = new Set();
    sameLineAnnotations = new Map();
    substitutedOperators = new Map();
    declaredOperators = new Set();
    const lines = source.split('\n');
    let changed = false;
    let offset = 0;
    let inTripleString = false;
    let nativeChain = false; // inside a leading-dot chain that parses natively
    let braceDepth = 0; // approximate brace depth (strings/comments stripped)
    const bracketStack: string[] = []; // open-bracket stack, same sanitization
    let enumBodyDepth = -1; // braceDepth of the innermost enum body, -1 outside
    let annoBracketDepth = 0; // unclosed `[` depth of a multi-line annotation argument list
    let macroParenDepth = 0; // inside a multi-line `@Macro[...](...)` body
    let commentDepth = 0; // block-comment nesting depth across lines
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]!;
      // Triple-quoted multi-line strings (\"\"\") — no grammar rule. Replace
      // the opener with a one-char literal and blank the rest through the
      // closer; content is irrelevant to extraction.
      // First `"""` at/after `from` NOT escaped — an odd backslash run before
      // it escapes the first quote (`\"""` inside the string must not close).
      const findTq = (str: string, from: number): number => {
        for (let at = str.indexOf('"""', from); at >= 0; at = str.indexOf('"""', at + 1)) {
          let bs = 0;
          while (at - 1 - bs >= 0 && str[at - 1 - bs] === '\\') bs++;
          if (bs % 2 === 0) return at;
        }
        return -1;
      };
      if (inTripleString) {
        const close = findTq(line, 0);
        if (close >= 0) {
          // Blank through the closer, KEEP what follows (a comma, `)`, …).
          lines[i] = ' '.repeat(close + 3) + line.slice(close + 3);
          inTripleString = false;
        } else {
          lines[i] = ' '.repeat(line.length);
        }
        line = lines[i]!;
        changed = true;
        if (inTripleString) { offset += lines[i]!.length + 1; continue; }
      }
      // Mask single-line raw strings first — `##""""##` legitimately contains
      // a `"""` substring that is NOT a triple-quote opener.
      const rawMasked = line.replace(/(##?)"[\s\S]*?"\1/g, (m) => ' '.repeat(m.length));
      const tq = findTq(rawMasked, 0);
      if (tq >= 0) {
        const close = findTq(rawMasked, tq + 3);
        if (close >= 0) {
          // Single-line: collapse to a one-char literal, keep the tail.
          line = lines[i] = line.slice(0, tq) + '" "' + ' '.repeat(close - tq) + line.slice(close + 3);
        } else {
          inTripleString = true;
          line = lines[i] = line.slice(0, tq) + '" "' + ' '.repeat(line.length - tq - 3);
        }
        changed = true;
      }
      // Allman-style braces: the lexer eats the newline after a function
      // signature as a declaration terminator, so `func f(): Bool` NEWLINE
      // `{` parses as a bodiless declaration plus an orphan block. Hoist the
      // `{` onto the signature line (same total bytes, same line count: the
      // signature line grows by ' {', this line's `{` is blanked; running
      // byte offset and bracket stack are compensated).
      const allman = line.match(/^(\s*)\{/);
      if (allman) {
        let prev = i - 1;
        while (prev >= 0 && lines[prev]!.trim() === '') prev--;
        const pl = prev >= 0 ? lines[prev]! : '';
        const isDecl = /\b(?:func|init|prop|struct|enum|interface|extend|main|else|try|catch|finally|do|if|while|for)\b/.test(pl)
          && /[)\w>]\s*$/.test(pl) && !/(?:=>|->|[={,(|&])\s*$/.test(pl) && !pl.trimStart().startsWith('//');
        if (prev >= 0 && isDecl) {
          lines[prev] = pl.trimEnd() + ' {' + ' '.repeat(pl.length - pl.trimEnd().length);
          line = lines[i] = allman[1] + ' ' + line.slice(allman[1]!.length + 1);
          offset += 2;
          braceDepth++;
          bracketStack.push('{');
          changed = true;
        }
      }
      // Unified comment scan. Two jobs: (a) the spec allows NESTED block
      // comments but the grammar's lexer ends at the first `*/` — blank the
      // inner delimiters so the region reads as one flat comment; (b) produce
      // a comment-free copy of the line for the brace tracking below.
      let codeLine = '';
      {
        const chars = line.split('');
        let j = 0;
        let inStr: string | null = null;
        while (j < chars.length) {
          const c = chars[j]!;
          const pair = c + (chars[j + 1] ?? '');
          if (commentDepth > 0) {
            if (pair === '/*') {
              chars[j] = ' ';
              chars[j + 1] = ' ';
              commentDepth++;
              changed = true;
              codeLine += '  ';
              j += 2;
              continue;
            }
            if (pair === '*/') {
              if (commentDepth > 1) {
                chars[j] = ' ';
                chars[j + 1] = ' ';
                changed = true;
              }
              commentDepth--;
              codeLine += '  ';
              j += 2;
              continue;
            }
            codeLine += ' ';
            j++;
            continue;
          }
          if (inStr) {
            if (c === '\\') {
              codeLine += '  ';
              j += 2;
              continue;
            }
            if (c === inStr) inStr = null;
            codeLine += ' ';
            j++;
            continue;
          }
          if (c === '"' || c === "'") {
            inStr = c;
            codeLine += ' ';
            j++;
            continue;
          }
          if (pair === '//') {
            codeLine += ' '.repeat(chars.length - j);
            break;
          }
          if (pair === '/*') {
            commentDepth = 1;
            codeLine += '  ';
            j += 2;
            continue;
          }
          codeLine += c;
          j++;
        }
        line = lines[i] = chars.join('');
      }
      // Enum bodies only admit cases, funcs and props — a `static let`/`var`
      // member (grammar gap) ERRORs and truncates the body. Track the brace
      // depth (comments/strings stripped via codeLine) to know when a line
      // sits DIRECTLY inside an enum body, and blank such members there
      // (losing one constant, keeping every case and func parseable).
      const depthAtStart = braceDepth;
      const topAtStart = bracketStack[bracketStack.length - 1];
      for (const ch of codeLine) {
        if (ch === '{') braceDepth++;
        else if (ch === '}') braceDepth--;
        if (ch === '{' || ch === '(' || ch === '[') {
          bracketStack.push(ch);
        } else if (ch === '}' || ch === ')' || ch === ']') {
          const want = ch === '}' ? '{' : ch === ')' ? '(' : '[';
          if (bracketStack[bracketStack.length - 1] === want) bracketStack.pop();
        }
      }
      if (enumBodyDepth >= 0 && braceDepth < enumBodyDepth) enumBodyDepth = -1;
      if (enumBodyDepth < 0 && braceDepth > depthAtStart && /^\s*(?:(?:public|private|protected|internal|sealed|open)\s+)*enum\s+[A-Za-z_]/.test(line)) {
        enumBodyDepth = braceDepth;
      }
      if (enumBodyDepth >= 0 && depthAtStart === enumBodyDepth && !line.includes('{')
        && /^\s*(?:(?:public|private|protected|internal|static|const)\s+)*(?:let|var)\s+[A-Za-z_]/.test(line)) {
        line = lines[i] = ' '.repeat(line.length);
        changed = true;
      }
      // Empty macro-quote `quote()` — the grammar's quote expression requires
      // content; a same-width plain identifier keeps the statement parseable.
      if (line.includes('quote()')) {
        line = lines[i] = line.replace(/\bquote\(\)/g, 'quote_x');
        changed = true;
      }
      // Generic-type token trees inside a quote (`quote(IJsonAdapter<$(t)>)`)
      // — the quoted `<...>` group cannot parse as an expression; blank it
      // (the base identifier still extracts as a reference).
      if (/\bquote\([^()]*?\w</.test(line)) {
        line = lines[i] = line.replace(/(\bquote\([^()]*?\w)<([^<>]*)>/g, (_m, pre, inner) => pre + ' '.repeat(inner.length + 2));
        changed = true;
      }
      // Backslash line continuations — blank the trailing backslash; a
      // binary operator left dangling at end of line parses fine.
      const contBs = line.match(/^(.*\S.*)\\\s*$/);
      if (contBs && !line.trimStart().startsWith('//')) {
        const at = line.lastIndexOf('\\');
        line = lines[i] = line.slice(0, at) + ' ' + line.slice(at + 1);
        changed = true;
      }
      // `@When` conditional-compilation annotation directly above an import —
      // the grammar can't attach an annotation to an import; blank the
      // annotation line (it is a compile-time switch, not graph content).
      if (/^\s*@When(\[.*\])?\s*$/.test(line) && i + 1 < lines.length && /^\s*(?:internal\s+|protected\s+|public\s+|private\s+)?import\b/.test(lines[i + 1]!)) {
        line = lines[i] = ' '.repeat(line.length);
        changed = true;
      }
      // `while (let md: Type <- expr)` / `if (let x: T <- e)` — the grammar
      // accepts let-bindings only WITHOUT a type annotation; blank it.
      const letBind = line.match(/((?:while|if)\s*\(\s*let\s+\w+)(\s*:\s*[\w.?<>\[\]]+)(\s*<-)/);
      if (letBind) {
        const at = line.indexOf(letBind[2]!, line.indexOf(letBind[1]!) + letBind[1]!.length - 1);
        line = lines[i] = line.slice(0, at) + ' '.repeat(letBind[2]!.length) + line.slice(at + letBind[2]!.length);
        changed = true;
      }
      // Named-tuple RETURN types — `): (group: UInt32, flags: Int64)` — the
      // grammar has no labeled tuple types; blank the labels (plain tuple
      // types parse). Call-site named ARGUMENTS are untouched (different
      // shape: no `): (` prefix).
      const namedTuple = line.match(/\)\s*:\s*\(([^()]*:[^()]*)\)/);
      if (namedTuple) {
        const inner = namedTuple[1]!;
        const blanked = inner.replace(/(^|,)(\s*)([A-Za-z_]\w*)(\s*):/g, (_m, pre, ws, name, ws2) => pre + ws + ' '.repeat(name.length) + ws2 + ' ');
        if (blanked !== inner) {
          line = lines[i] = line.replace(inner, blanked);
          changed = true;
        }
      }
      // `public operator override func ==` — the grammar only accepts
      // `override operator`; the two spellings are the same length, so swap
      // in place.
      if (line.includes('operator override')) {
        line = lines[i] = line.replace(/operator override/g, 'override operator');
        changed = true;
      }
      // The CALL operator `operator func ()(...)` — no such symbol in the
      // grammar's operator rule. Substitute the same-width `==` so the member
      // parses as an operator function, and record the real symbol for
      // resolveName.
      // Receiver-syntax extension functions (`func String.padEnd(w: Int64)`)
      // — no grammar rule for the `Type.` prefix. Blank it; the function
      // extracts under its bare name (extend-like semantics).
      const recvFn = line.match(/(func\s+)([A-Z]\w*\.)(?=[a-z_])/);
      if (recvFn) {
        const at = line.indexOf(recvFn[2]!, line.indexOf(recvFn[1]!));
        line = lines[i] = line.slice(0, at) + ' '.repeat(recvFn[2]!.length) + line.slice(at + recvFn[2]!.length);
        changed = true;
      }
      const opDecl = line.match(/\boperator\s+(?:override\s+)?func\s*([^\s(<]+|\[\])/);
      if (opDecl) declaredOperators.add(opDecl[1]!);
      const callOp = line.match(/operator\s+func\s*\(\)/);
      if (callOp) {
        substitutedOperators.set(i + 1, '()');
        line = lines[i] = line.replace(/(operator\s+func\s*)\(\)/, '$1==');
        changed = true;
      }
      // Multi-line DSL macro invocation — `@Enum[SimpleEnum](` newline
      // `Val1` … `)` — the grammar only parses single-line macro calls.
      // Blank the parenthesized body; the `@Enum[...]` residue is handled by
      // the annotation rules below and survives as a plain annotation.
      if (macroParenDepth > 0) {
        let cut = -1;
        for (let j = 0; j < codeLine.length; j++) {
          if (codeLine[j] === '(') macroParenDepth++;
          else if (codeLine[j] === ')') {
            macroParenDepth--;
            if (macroParenDepth === 0) { cut = j; break; }
          }
        }
        line = lines[i] = cut >= 0 ? ' '.repeat(cut + 1) + line.slice(cut + 1) : ' '.repeat(line.length);
        changed = true;
      } else {
        const macroOpen = line.match(/^(\s*@[A-Za-z_][\w.]*(?:\[[^\]]*\])?)\(/);
        if (macroOpen) {
          let depth = 0;
          for (const ch of codeLine.slice(macroOpen[1]!.length)) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
          }
          if (depth > 0) {
            line = lines[i] = macroOpen[1] + ' '.repeat(line.length - macroOpen[1]!.length);
            macroParenDepth = depth;
            changed = true;
          }
        }
      }
      // Own-line annotation with an argument list the grammar can't parse
      // (`@Subscriber[threadmode: MAIN, sticky: true]`, `@Entity[tableName =
      // "x"]`) — blank the bracket part; the name is what decorators keep.
      const annoArgs = line.match(/^(\s*)(@!?[A-Za-z_][\w.]*)(\[.*\])(\s*)$/);
      if (annoArgs) {
        // `@!Name` (compiler-annotation form, e.g. `@!APILevel[...]`) has no
        // grammar rule at all — blank the name along with the arguments.
        const keepName = !annoArgs[2]!.startsWith('@!');
        line = lines[i] = annoArgs[1]!
          + (keepName ? annoArgs[2]! : ' '.repeat(annoArgs[2]!.length))
          + ' '.repeat(annoArgs[3]!.length) + annoArgs[4]!;
        changed = true;
      }
      // The open-enum marker `...` (`| ...` as the last case) — spec syntax
      // the grammar predates. A same-width placeholder case keeps the body.
      const ellipsis = line.match(/^(.*?\|\s*|\s*)\.\.\.(\s*)$/);
      if (ellipsis && !line.includes('//')) {
        line = lines[i] = ellipsis[1] + '___' + ellipsis[2];
        changed = true;
      }
      // A bare `@!Name` compiler annotation (no arguments) — no grammar
      // rule; blank the whole line.
      const bangAnno = line.match(/^(\s*\|?)(\s*@![\w.]+\s*)$/);
      if (bangAnno) {
        line = lines[i] = bangAnno[1] + ' '.repeat(bangAnno[2]!.length);
        changed = true;
      }
      // The MULTI-LINE form of the same (`@agent[` … `]` spanning lines) —
      // blank from the `[` through the closing `]`; the bare `@agent` line
      // that survives parses as a normal annotation.
      if (annoBracketDepth > 0) {
        // The argument list may hold NESTED brackets (`examples: [...]`) —
        // blank through the `]` that returns the depth to zero.
        let cut = -1;
        for (let j = 0; j < line.length; j++) {
          if (line[j] === '[') annoBracketDepth++;
          else if (line[j] === ']') {
            annoBracketDepth--;
            if (annoBracketDepth === 0) { cut = j; break; }
          }
        }
        line = lines[i] = cut >= 0 ? ' '.repeat(cut + 1) + line.slice(cut + 1) : ' '.repeat(line.length);
        changed = true;
      } else {
        const annoOpen = line.match(/^(\s*\|?\s*)(@!?[A-Za-z_][\w.]*)\[/);
        if (annoOpen) {
          let depth = 0;
          for (const ch of line.slice(annoOpen[0]!.length - 1)) {
            if (ch === '[') depth++;
            else if (ch === ']') depth--;
          }
          if (depth > 0) {
            const keepName = !annoOpen[2]!.startsWith('@!');
            const kept = annoOpen[1]! + (keepName ? annoOpen[2]! : ' '.repeat(annoOpen[2]!.length));
            line = lines[i] = kept + ' '.repeat(line.length - kept.length);
            annoBracketDepth = depth;
            changed = true;
          }
        }
      }
      // A `let`-binding as a NON-SOLE condition (`while (a && let x <- e)`)
      // has no grammar rule — blank just the `let` keyword; the remaining
      // `x <- e` parses as an expression and both operands keep extracting.
      if (/\b(?:while|if)\s*\(/.test(line) && /(?:&&|\|\|)\s+let\s/.test(line)) {
        line = lines[i] = line.replace(/((?:&&|\|\|)\s+)let(\s)/g, (_m, pre, ws) => pre + '   ' + ws);
        changed = true;
      }
      // Cross-line form: the condition wraps after `&&`/`||` and the
      // let-binding starts the next line.
      const letCont = line.match(/^(\s*)let(\s)/);
      if (letCont && i > 0 && /(?:&&|\|\|)\s*$/.test(lines[i - 1]!)) {
        line = lines[i] = letCont[1] + '   ' + line.slice(letCont[1]!.length + 3);
        changed = true;
      }
      // A continuation line starting with `|` (multi-line flag unions —
      // `Flag.A` newline `| Flag.B`) — same gap as leading `+` below. Enum
      // CASES also start with `|` and are real grammar: skip lines sitting
      // directly inside an enum body.
      const pipeCont = line.match(/^(\s*)\|\s/);
      if (pipeCont && (enumBodyDepth < 0 || depthAtStart !== enumBodyDepth)) {
        // Match-arm alternations (`case A` newline `| B => …`) parse
        // natively — skip when the previous non-blank line is a `case` or a
        // still-piped alternation line, or this line carries the arrow.
        let pprev = i - 1;
        while (pprev >= 0 && lines[pprev]!.trim() === '') pprev--;
        const prevTrim = pprev >= 0 ? lines[pprev]!.trimStart() : '';
        const isMatchAlt = /^case\b/.test(prevTrim) || prevTrim.startsWith('|') || line.includes('=>');
        if (!isMatchAlt) {
          line = lines[i] = pipeCont[1] + ' ' + line.slice(pipeCont[1]!.length + 1);
          changed = true;
        }
      }
      // A continuation line STARTING with a binary `+` (multi-line arithmetic
      // — `+ this.mLegend.getXOffset()`) has no grammar rule; blank the
      // operator so the operand parses as its own expression statement (its
      // calls still extract, attributed to the same enclosing member).
      const plusCont = line.match(/^(\s*)\+\s/);
      if (plusCont) {
        line = lines[i] = plusCont[1] + ' ' + line.slice(plusCont[1]!.length + 1);
        changed = true;
      }
      // A continuation line starting with `=` (an initializer wrapped onto
      // its own line under a typed declaration). A bare expression statement
      // is not a legal class-body member, so the whole line is blanked —
      // losing that one initializer call but keeping the class parseable
      // (the typed declaration above it extracts as a normal field).
      const eqCont = line.match(/^(\s*)=(?![=>])/);
      if (eqCont) {
        line = lines[i] = ' '.repeat(line.length);
        changed = true;
      }
      // The grammar hardcodes `Range` as a builtin GENERIC type — a bare
      // `: Range` type annotation (user-defined Range class) ERRORs. Swap in
      // a same-width placeholder; the field/param still extracts (its type
      // edge to the user's Range is lost, the lesser evil).
      if (/:\s*\??Range\b/.test(line)) {
        line = lines[i] = line.replace(/(:\s*\??)Range\b(?!\s*<)/g, '$1RangX');
        changed = true;
      }
      // Bitwise NOT `~` (C-heritage code) — not in the grammar's operator
      // set; the same-width prefix `!` parses identically for extraction.
      // `~init` finalizers are real grammar and must stay.
      if (/~(?!init\b)(?=[\w(])/.test(line)) {
        line = lines[i] = line.replace(/~(?!init\b)(?=[\w(])/g, '!');
        changed = true;
      }
      // Zig-style underscore literal suffixes (`0_u64`) — blank the suffix;
      // the bare number parses and values are irrelevant to the graph.
      if (/\d_[iu](?:8|16|32|64)\b/.test(line)) {
        line = lines[i] = line.replace(/\b((?:0[xXoObB])?[\da-fA-F]*\d)_([iu](?:8|16|32|64))\b/g, (_m, num, suf) => num + ' '.repeat(suf.length + 1));
        changed = true;
      }
      // A byte literal holding a double quote (`b'"'`) breaks the lexer
      // (the rune form `'"'` is fine); content is irrelevant — blank it.
      if (line.includes(`b'"'`)) {
        line = lines[i] = line.replaceAll(`b'"'`, `b' '`);
        changed = true;
      }
      // An escaped space (`"a\\ b"`) has no grammar escape rule — the
      // backslash pairs with the following space either way.
      if (/\\ /.test(line) && !/^\s*\/\//.test(line)) {
        // Only an ODD run of backslashes escapes the space (`\\ ` is an
        // escaped backslash FOLLOWED by a space — legal, leave it alone).
        line = lines[i] = line.replace(/\\+ /g, (m) => ((m.length - 1) % 2 === 1 ? m.slice(0, -2) + '  ' : m));
        changed = true;
      }
      // Multi-dimensional index access (`m[l1, l2]`) — the grammar's index
      // suffix takes ONE expression; a same-width `+` keeps every operand
      // referenced (values are irrelevant to the graph). Array LITERALS
      // (`= [1, 2]`) parse natively — only matches after a value expression.
      if (/[\w)\]]\[[^\[\]]*,/.test(line)) {
        line = lines[i] = line.replace(/([\w)\]])(\[[^\[\]"']*,[^\[\]"']*\])/g,
          (_m, pre, grp) => pre + grp.replace(/,/g, '+'));
        changed = true;
      }
      // Byte-string literals (`b"pwd"`) — no grammar rule; blank the prefix,
      // the plain string parses at the same offsets.
      if (/(?:^|[^\w"'])b"/.test(line)) {
        line = lines[i] = line.replace(/(^|[^\w"'])b(?=")/g, '$1 ');
        changed = true;
      }
      // The full-range index `a[..]` (slice-all) — no grammar rule for a
      // bare open range; a same-width literal index keeps the statement.
      if (line.includes('[..]')) {
        line = lines[i] = line.replaceAll('[..]', '[ 0]');
        changed = true;
      }
      // An annotation/macro argument list in EXPRESSION position
      // (`let r = @LbRequest[k = "v"]()`) — the line-start rules above only
      // cover declaration-site annotations; blank the bracket group here too.
      if (/=\s*@[A-Za-z_][\w.]*\[/.test(line)) {
        line = lines[i] = line.replace(/(@[A-Za-z_][\w.]*)\[[^\]]*\]/g, (m, name) => name + ' '.repeat(m.length - name.length));
        changed = true;
      }
      // A rune literal holding a dollar (`case '$' | …`) breaks the lexer
      // like the string forms above.
      if (line.includes("'$'")) {
        line = lines[i] = line.replace(/'\$'/g, "' '");
        changed = true;
      }
      // `$` immediately before `)` only occurs inside string content (regex
      // patterns — `(?:\\s|>|$)`); the lexer treats it as a broken
      // interpolation. Content is irrelevant to extraction — blank it.
      if (line.includes('$)') || /\$["']/.test(line)) {
        // `$"` / `$'` (a regex end-anchor closing the string) breaks the
        // lexer the same way — but `"$"`/`'$'` (lone-dollar literals) are
        // handled above and legitimate interpolation is `${` or
        // `$identifier`, never `$"`.
        line = lines[i] = line.replace(/\$\)/g, ' )').replace(/\$(?=["'])/g, ' ');
        changed = true;
      }
      // `from module import pkg.path.*` — cross-module import syntax the
      // grammar predates. Blank the `from module ` prefix; the remaining
      // `import pkg.path.*` sits at its original byte offsets and parses
      // (and extracts) as a normal import.
      const fromImport = line.match(/^(\s*)(from\s+[\w.]+\s+)(?=import\b)/);
      if (fromImport) {
        line = lines[i] = fromImport[1] + ' '.repeat(fromImport[2]!.length) + line.slice(fromImport[1]!.length + fromImport[2]!.length);
        changed = true;
      }
      // A trailing comma in a braced import list (`import a.{B, }`) — the
      // grammar wants no dangling comma; blank it.
      if (/^\s*(?:\w+\s+)?import\b.*,\s*}/.test(line)) {
        line = lines[i] = line.replace(/,(\s*})/g, ' $1');
        changed = true;
      }
      // Access-modified imports (`internal import x`, `protected import y`) —
      // the newer cjpm convention the grammar predates. Blank the modifier.
      const modImport = line.match(/^(\s*)((?:internal|protected|public|private)\s+)(?=import\b)/);
      if (modImport) {
        line = lines[i] = modImport[1] + ' '.repeat(modImport[2]!.length) + line.slice(modImport[1]!.length + modImport[2]!.length);
        changed = true;
      }
      // Module-qualified package paths (`package cangjie_tpc::prism4cj`,
      // `import cangjie_tpc::prism4cj.languages.*`) — the `::` separator has
      // no grammar rule and ERRORs the whole file header. Same-width `__`
      // keeps the path one parseable dotted identifier chain (the mangling is
      // visible only in package/import records, never in symbols).
      if (line.includes('::') && /^\s*(?:package\b|import\b|macro\s+package\b)/.test(line)) {
        line = lines[i] = line.replace(/::/g, '__');
        changed = true;
      }
      // Supertype generic arguments — `<: ResponseBuilder<ArrayList<Any>>` —
      // nest deeper than the grammar handles. Blank each supertype's balanced
      // `<...>` group after the `<:`; the extends/implements edge uses the
      // bare identifier either way.
      const subIdx = line.indexOf('<:');
      if (subIdx >= 0) {
        const blanked = blankSupertypeGenerics(line, subIdx + 2);
        if (blanked !== line) {
          line = lines[i] = blanked;
          changed = true;
        }
      }
      // A string literal holding a bare dollar sign lexes as a broken
      // interpolation. The content is irrelevant to extraction — blank it.
      if (line.includes('"$"')) {
        line = lines[i] = line.replace(/"\$"/g, '" "');
        changed = true;
      }
      // Same-line annotated member (`@Publish public var x = 1`): blank the
      // annotation tokens so the member parses as a plain declaration (two
      // consecutive same-line annotated members otherwise ERROR and truncate
      // the class body), and record the names for collectMacroAnnotations.
      const inlineAnno = line.match(/^(\s*)((?:@[A-Za-z_][\w.]*(?:\[[^\]]*\])?\s+)+)(?=(?:public|private|protected|internal|static|open|override|mut|unsafe|foreign|const|let|var|func|prop)\b)/);
      if (inlineAnno) {
        const names = [...inlineAnno[2]!.matchAll(/@([A-Za-z_][\w.]*)/g)].map((m) => m[1]!);
        sameLineAnnotations.set(i + 1, names);
        line = lines[i] = inlineAnno[1] + ' '.repeat(inlineAnno[2]!.length) + line.slice(inlineAnno[1]!.length + inlineAnno[2]!.length);
        changed = true;
      }
      const dot = line.match(/^(\s*)\.[A-Za-z_]/);
      if (dot) {
        // A chain hanging off a raw-string literal (`where #'…'#` newline
        // `.regex(…)` newline `.matches(…)`) parses NATIVELY as an expression
        // continuation — the whole chain must stay untouched. Only chains
        // after a completed statement (`)`, `}`) need the blanking.
        let prev = i - 1;
        while (prev >= 0 && lines[prev]!.trim() === '') prev--;
        const prevEnd = prev >= 0 ? lines[prev]!.trimEnd().slice(-1) : '';
        // Directly inside an unclosed paren/bracket group (a multi-line
        // condition or argument list) a leading-dot chain is a NATIVE
        // expression continuation — but inside a BRACE block (statement
        // context, e.g. a lambda body nested in that argument list) it still
        // needs the blanking.
        if (prevEnd === '#' || topAtStart === '(' || topAtStart === '[' || nativeChain) {
          nativeChain = true;
        } else {
          blankedDotOffsets.add(offset + dot[1]!.length);
          lines[i] = dot[1] + ' ' + line.slice(dot[1]!.length + 1);
          changed = true;
          offset += line.length + 1;
          continue;
        }
      } else {
        nativeChain = false;
      }
      const prop = line.match(/^(\s*)((?:(?:public|private|protected|internal|static|mut|open|override)\s+)*prop\s+[A-Za-z_]\w*\s*:[^{]*)$/);
      if (prop) {
        lines[i] = prop[1] + ' '.repeat(prop[2]!.length);
        // Blank the prop's own doc comment too — with the declaration gone,
        // an adjacent comment would otherwise attach to the NEXT member.
        for (let j = i - 1; j >= 0; j--) {
          const above = lines[j]!;
          if (/^\s*\/\//.test(above) || /^\s*\/\*.*\*\/\s*$/.test(above)) {
            lines[j] = ' '.repeat(above.length);
            continue;
          }
          if (/\*\/\s*$/.test(above)) {
            // multi-line block comment: blank up to its /* opener
            let k = j;
            while (k >= 0 && !/\/\*/.test(lines[k]!)) {
              lines[k] = ' '.repeat(lines[k]!.length);
              k--;
            }
            if (k >= 0) lines[k] = ' '.repeat(lines[k]!.length);
            j = k;
            continue;
          }
          break;
        }
        changed = true;
      }
      offset += line.length + 1;
    }
    return changed ? lines.join('\n') : source;
  },

  // `func` at top level is a function; the same node inside a class/struct/
  // interface/enum body classifies as a method via methodTypes (the core's
  // isInsideClassLikeNode check). `main() { }` and constructors (`init`) /
  // operator overloads only ever appear at their fixed positions.
  functionTypes: ['functionDefinition', 'mainDefinition'],
  // extendDefinition follows the Swift-extension precedent: `extend Foo {…}`
  // extracts as a class node NAMED Foo, so its members classify as methods
  // with `Foo::member` qualified names and calls resolve alongside the
  // original class's own methods.
  classTypes: ['classDefinition', 'extendDefinition'],
  methodTypes: ['functionDefinition', 'init', 'operatorFunctionDefinition'],
  interfaceTypes: ['interfaceDefinition'],
  structTypes: ['structDefinition'],
  enumTypes: ['enumDefinition'],
  typeAliasTypes: [],
  importTypes: ['importList'],
  // A call is a `callSuffix` (`foo(x)`) or a paren-less trailing lambda
  // (`Column { … }`, `list.forEach { x => … }` — the dominant ArkUI idiom,
  // which produces NO callSuffix at all) hanging off a `postfixExpression`;
  // the callee is the suffix's preceding sibling, resolved structurally by
  // cangjieCalleeName via the cangjie branch in extractCall (tree-sitter.ts).
  callTypes: ['callSuffix', 'trailingLambdaExpression', 'binaryExpreesion'],
  variableTypes: [],
  // propertyDefinition is handled entirely by the visitNode hook below (the
  // core's extractProperty neither finds `propertyName` nor visits the
  // getter/setter blocks, so accessor-body calls would be dropped).
  propertyTypes: [],
  nameField: 'name', // unused — the grammar has no fields; resolveName does the work
  bodyField: 'block',
  paramsField: 'parameters',

  resolveName: (node, source) => {
    const nameType = NAME_CHILD_TYPES[node.type];
    if (nameType) {
      const nameNode = directChild(node, nameType);
      if (nameNode) return getNodeText(nameNode, source);
    }
    if (node.type === 'mainDefinition') return 'main';
    if (node.type === 'init') return 'init';
    if (node.type === 'extendDefinition') {
      // extendType wraps an identifier for user types (`extend Widget`,
      // `extend Array<T>`), but a BUILT-IN type (`extend String`) is a bare
      // token — fall back to the extendType text minus any type arguments.
      const extendType = directChild(node, 'extendType');
      if (!extendType) return undefined;
      const id = directChild(extendType, 'identifier');
      if (id) return getNodeText(id, source);
      return getNodeText(extendType, source).replace(/<[\s\S]*$/, '').trim() || undefined;
    }
    if (node.type === 'operatorFunctionDefinition') {
      const substituted = substitutedOperators.get(node.startPosition.row + 1);
      if (substituted) return `operator ${substituted}`;
      const op = directChild(node, 'operator');
      return op ? `operator ${getNodeText(op, source)}` : 'operator';
    }
    return undefined;
  },

  resolveBody: (node) => directChildOf(node, BODY_CHILD_TYPES),

  // Surface macro annotations on every node's `decorators` list — searchable
  // (`@Entry` pages, `@Builder` slots), and what the ArkUI-in-Cangjie
  // state→build() synthesizer keys off (`@State` fields).
  extractModifiers: (node) => collectMacroAnnotations(node),

  visitNode: (node, ctx) => {
    // `prop name: T { get() {...} set(v) {...} }` — create the property node and
    // walk BOTH accessor blocks as its body so getter/setter calls become edges.
    if (node.type === 'propertyDefinition') {
      const nameNode = directChild(node, 'propertyName');
      if (!nameNode) return false;
      const prop = ctx.createNode('property', getNodeText(nameNode, ctx.source), node);
      if (prop) {
        for (const declaredType of fieldTypeNames(node)) {
          ctx.addUnresolvedReference({
            fromNodeId: prop.id,
            referenceName: declaredType,
            referenceKind: 'references',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
        // visitFunctionBody attributes calls to the top of the scope stack, not
        // to its functionId argument — push the property before walking.
        ctx.pushScope(prop.id);
        for (const child of node.namedChildren) {
          if (child && child.type === 'block') {
            ctx.visitFunctionBody(child, prop.id);
          }
        }
        ctx.popScope();
      }
      return true;
    }
    // Enum cases are bare `identifier` children of enumBody (`| Cell(Int64)`
    // puts the payload TYPES as separate siblings, so the identifier IS the
    // case name) — parent-gated so no other identifier ever matches.
    if (node.type === 'identifier' && node.parent?.type === 'enumBody') {
      ctx.createNode('enum_member', getNodeText(node, ctx.source), node);
      return true;
    }
    // Class-body `let`/`var` declarations are FIELDS (`@State var count = 0`
    // reactive state included — its annotations land on the field node via
    // extractModifiers). A named user type in the declaration
    // (`let repo: Repository`) emits a `references` edge so "who uses this
    // type" includes fields. Gated on the enclosing scope being class-like so
    // function-local and top-level declarations stay unextracted.
    if (node.type === 'variableDeclaration') {
      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const parent = parentId ? ctx.nodes.find((n) => n.id === parentId) : undefined;
      if (!parent) return false;
      // PACKAGE-level let/var: a real symbol — often the app's wiring point
      // (`let ENTRY_STAGE_REGISTER_RESULT = AbilityStage.registerCreator(
      // "entry", {=> MyAbilityStage()})` IS the entry→AbilityStage link), so
      // it must exist as a node the initializer's calls attribute to.
      // `let _ = …` keeps its calls on the file (no symbol to name).
      if (parent.kind === 'file') {
        const isLet = node.children.some((c) => c?.type === 'let');
        const tops = node.namedChildren
          .filter((c) => c?.type === 'variableName' && getNodeText(c!, ctx.source) !== '_')
          .map((c) => ctx.createNode(isLet ? 'constant' : 'variable', getNodeText(c!, ctx.source), node))
          .filter((v) => v !== null);
        const topScope = tops.length === 1 ? tops[0]!.id : undefined;
        if (topScope) ctx.pushScope(topScope);
        ctx.visitFunctionBody(node, topScope ?? '');
        if (topScope) ctx.popScope();
        return true;
      }
      if (!CLASS_LIKE_KINDS.has(parent.kind)) return false;
      const fields = node.namedChildren
        .filter((c) => c?.type === 'variableName')
        .map((c) => ctx.createNode('field', getNodeText(c!, ctx.source), node))
        .filter((f) => f !== null);
      for (const declaredType of fieldTypeNames(node)) {
        for (const f of fields) {
          ctx.addUnresolvedReference({
            fromNodeId: f!.id,
            referenceName: declaredType,
            referenceKind: 'references',
            line: node.startPosition.row + 1,
            column: node.startPosition.column,
          });
        }
      }
      // The initializer may call (`var vm = makeDefault()`): walk it for call
      // edges, attributed to the field when the declaration has exactly one.
      const scopeId = fields.length === 1 ? fields[0]!.id : undefined;
      if (scopeId) ctx.pushScope(scopeId);
      ctx.visitFunctionBody(node, scopeId ?? '');
      if (scopeId) ctx.popScope();
      return true;
    }
    return false;
  },

  getSignature: (node, source) => {
    const params = directChild(node, 'parameterList') ?? directChild(node, 'primaryInitParamList');
    if (!params) return undefined;
    const ret = directChild(node, 'returnType');
    const paramsText = getNodeText(params, source);
    if (!ret) return paramsText;
    // The returnType node carries its own leading ':' token — normalize so the
    // signature reads `(x: Int64): String`, not `(x: Int64): : String`.
    const retText = getNodeText(ret, source).replace(/^\s*:\s*/, '');
    return `${paramsText}: ${retText}`;
  },

  getVisibility: (node) => {
    const modifiers = directChild(node, 'modifiers');
    if (!modifiers) return undefined;
    const text = modifiers.text;
    if (/\bpublic\b/.test(text)) return 'public';
    if (/\bprivate\b/.test(text)) return 'private';
    if (/\bprotected\b/.test(text)) return 'protected';
    if (/\binternal\b/.test(text)) return 'internal';
    return undefined;
  },

  isStatic: (node) => {
    const modifiers = directChild(node, 'modifiers');
    return modifiers ? /\bstatic\b/.test(modifiers.text) : false;
  },

  // Cangjie has no export statement — `public` IS the cross-package export.
  isExported: (node) => {
    const modifiers = directChild(node, 'modifiers');
    return modifiers ? /\bpublic\b/.test(modifiers.text) : false;
  },

  // `import pkg.sub.Item` / `import pkg.{A, B}` / `import pkg.* ` — record the
  // dotted module path (up to the last segment group) so file-level import
  // edges exist; symbol resolution itself is package-global in Cangjie, which
  // the name-matcher's exact-name strategy already covers.
  extractImport: (node, source) => {
    // The grammar absorbs a comment FOLLOWING the import into the import
    // node (`import ohos.resource.*` newline `/** … */` — the node text
    // carried the whole comment). Only the first line is the import; strip
    // any trailing comment start from it too.
    const firstLine = (getNodeText(node, source).trim().split('\n')[0] ?? '')
      .replace(/\/\/.*$/, '')
      .replace(/\/\*.*$/, '')
      .trim();
    const m = firstLine.match(/^import\s+(.+)$/);
    if (!m || !m[1]) return null;
    const spec = m[1].trim();
    // Strip an alias (`import a.b as c`), then reduce to the PACKAGE path:
    // `pkg.{A, B}` drops the member group; `pkg.Member` drops the final
    // segment (Cangjie imports always name a member); a wildcard import
    // keeps its `.*` (it IS the package path, spelled as in source).
    let moduleName = spec.replace(/\s+as\s+\w+$/, '');
    if (/\.\{[^}]*\}$/.test(moduleName)) {
      moduleName = moduleName.replace(/\.\{[^}]*\}$/, '');
    } else if (!moduleName.endsWith('.*') && moduleName.includes('.')) {
      moduleName = moduleName.slice(0, moduleName.lastIndexOf('.'));
    }
    if (!moduleName) return null;
    return { moduleName, signature: firstLine };
  },
};
