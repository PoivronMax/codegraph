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
        return text || undefined;
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

export const cangjieExtractor: LanguageExtractor = {
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
      const op = directChild(node, 'operator');
      return op ? `operator ${getNodeText(op, source)}` : 'operator';
    }
    return undefined;
  },

  resolveBody: (node) => directChildOf(node, BODY_CHILD_TYPES),

  // `prop name: T { get() {...} set(v) {...} }` — create the property node and
  // walk BOTH accessor blocks as its body so getter/setter calls become edges.
  visitNode: (node, ctx) => {
    if (node.type !== 'propertyDefinition') return false;
    const nameNode = directChild(node, 'propertyName');
    if (!nameNode) return false;
    const prop = ctx.createNode('property', getNodeText(nameNode, ctx.source), node);
    if (prop) {
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

  // `import pkg.sub.Item` / `import pkg.{A, B}` / `import pkg.* ` — record the
  // dotted module path (up to the last segment group) so file-level import
  // edges exist; symbol resolution itself is package-global in Cangjie, which
  // the name-matcher's exact-name strategy already covers.
  extractImport: (node, source) => {
    const text = getNodeText(node, source).trim();
    const m = text.match(/^import\s+(.+)$/s);
    if (!m || !m[1]) return null;
    const spec = m[1].trim();
    // Strip an alias (`import a.b as c`), then reduce to the PACKAGE path:
    // `pkg.{A, B}` / `pkg.*` drop the member group/wildcard; `pkg.Member`
    // drops the final segment (Cangjie imports always name a member).
    let moduleName = spec.replace(/\s+as\s+\w+$/, '');
    if (/\.\{[^}]*\}$/.test(moduleName)) {
      moduleName = moduleName.replace(/\.\{[^}]*\}$/, '');
    } else if (moduleName.endsWith('.*')) {
      moduleName = moduleName.slice(0, -2);
    } else if (moduleName.includes('.')) {
      moduleName = moduleName.slice(0, moduleName.lastIndexOf('.'));
    }
    if (!moduleName) return null;
    return { moduleName, signature: text.split('\n')[0] ?? text };
  },
};
