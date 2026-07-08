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
      case 'fieldAccess':
        // Both carry a single name child (fieldAccess: `.name` → atomicVariable)
        expr = expr.namedChildren.find((c) => c !== null) ?? null;
        continue;
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
    const lines = source.split('\n');
    let changed = false;
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i]!;
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
      const callOp = line.match(/operator\s+func\s+\(\)/);
      if (callOp) {
        substitutedOperators.set(i + 1, '()');
        line = lines[i] = line.replace(/(operator\s+func\s+)\(\)/, '$1==');
        changed = true;
      }
      // Own-line annotation with an argument list the grammar can't parse
      // (`@Subscriber[threadmode: MAIN, sticky: true]`, `@Entity[tableName =
      // "x"]`) — blank the bracket part; the name is what decorators keep.
      const annoArgs = line.match(/^(\s*@[A-Za-z_][\w.]*)(\[[^\]]*\])(\s*)$/);
      if (annoArgs) {
        line = lines[i] = annoArgs[1] + ' '.repeat(annoArgs[2]!.length) + annoArgs[3];
        changed = true;
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
      // A rune literal holding a dollar (`case '$' | …`) breaks the lexer
      // like the string forms above.
      if (line.includes("'$'")) {
        line = lines[i] = line.replace(/'\$'/g, "' '");
        changed = true;
      }
      // `$` immediately before `)` only occurs inside string content (regex
      // patterns — `(?:\\s|>|$)`); the lexer treats it as a broken
      // interpolation. Content is irrelevant to extraction — blank it.
      if (line.includes('$)') || /\$"/.test(line)) {
        // `$"` (a regex end-anchor closing the string) breaks the lexer the
        // same way — but `"$"` (lone-dollar literal) is handled above and
        // legitimate interpolation is `${` or `$identifier`, never `$"`.
        line = lines[i] = line.replace(/\$\)/g, ' )').replace(/\$(?=")/g, ' ');
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
        blankedDotOffsets.add(offset + dot[1]!.length);
        lines[i] = dot[1] + ' ' + line.slice(dot[1]!.length + 1);
        changed = true;
        offset += line.length + 1;
        continue;
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
  callTypes: ['callSuffix', 'trailingLambdaExpression'],
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
