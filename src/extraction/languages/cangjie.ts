import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// Node names follow the vendored Cangjie grammar (Cangjie-SIG/
// tree-sitter-cangjie 1.1.0 — see vendor/tree-sitter-cangjie). The grammar
// declares NO fields: names, bodies, and parameter lists are all plain named
// children (funcName/className/…, block/classBody/…), so this extractor works
// through the resolveName/resolveBody hooks rather than the *Field configs.

/** First DIRECT child of the given type, or null. */
function directChild(node: SyntaxNode, type: string): SyntaxNode | null {
  for (const child of node.children) {
    if (child && child.type === type) return child;
  }
  return null;
}

/** First DIRECT child among the given types, or null. */
function directChildOf(node: SyntaxNode, types: readonly string[]): SyntaxNode | null {
  for (const child of node.children) {
    if (child && types.includes(child.type)) return child;
  }
  return null;
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
] as const;

export const cangjieExtractor: LanguageExtractor = {
  // `func` at top level is a function; the same node inside a class/struct/
  // interface/enum body classifies as a method via methodTypes (the core's
  // isInsideClassLikeNode check). `main() { }` and constructors (`init`) /
  // operator overloads only ever appear at their fixed positions.
  functionTypes: ['functionDefinition', 'mainDefinition'],
  classTypes: ['classDefinition'],
  methodTypes: ['functionDefinition', 'init', 'operatorFunctionDefinition'],
  interfaceTypes: ['interfaceDefinition'],
  structTypes: ['structDefinition'],
  enumTypes: ['enumDefinition'],
  typeAliasTypes: [],
  importTypes: ['importList'],
  // A call is `postfixExpression` carrying a `callSuffix` child; the callee
  // name lives OUTSIDE the suffix (rightmost name-leaf preceding it), so call
  // extraction is a cangjie branch in extractCall — see tree-sitter.ts.
  callTypes: ['callSuffix'],
  variableTypes: [],
  propertyTypes: ['propertyDefinition'],
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
    if (node.type === 'operatorFunctionDefinition') {
      const op = directChild(node, 'operator');
      return op ? `operator ${getNodeText(op, source)}` : 'operator';
    }
    return undefined;
  },

  resolveBody: (node) => directChildOf(node, BODY_CHILD_TYPES),

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
