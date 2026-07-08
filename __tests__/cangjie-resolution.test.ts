/**
 * Cangjie end-to-end resolution tests.
 *
 * Pins the ArkUI-in-Cangjie state→build() re-render bridge: a `@Component
 * class` method that
 * ASSIGNS a `@State`-decorated field gets a synthesized calls edge to the
 * class's `build()`; a method that only READS state — or writes a
 * non-reactive field — must get nothing (the assignment gate is the precision
 * line).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Cangjie ArkUI state → build() bridge', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links assigning methods to build(), gated on reactive fields and component annotation', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    fs.writeFileSync(
      path.join(tmpDir, 'counter_view.cj'),
      'package demo\n' +
        '\n' +
        '@Entry\n' +
        '@Component\n' +
        'public class CounterView {\n' +
        '    @State\n' +
        '    var count: Int64 = 0\n' +
        '\n' +
        '    var plain: Int64 = 0\n' +
        '\n' +
        '    func increment(): Unit {\n' +
        '        this.count = this.count + 1\n' +
        '    }\n' +
        '\n' +
        '    func readOnly(): Int64 {\n' +
        '        return this.count\n' +
        '    }\n' +
        '\n' +
        '    func touchPlain(): Unit {\n' +
        '        this.plain = 5\n' +
        '    }\n' +
        '\n' +
        '    func build(): Unit {\n' +
        '        Column { Text("x") }\n' +
        '    }\n' +
        '}\n' +
        '\n' +
        '// NOT a component: same shape, no @Component annotation — no bridge.\n' +
        'public class PlainBuilderHolder {\n' +
        '    @State\n' +
        '    var value: Int64 = 0\n' +
        '    func poke(): Unit { this.value = 1 }\n' +
        '    func build(): Unit {}\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const build = methods.find((n) => n.qualifiedName === 'CounterView::build');
    const increment = methods.find((n) => n.name === 'increment');
    const readOnly = methods.find((n) => n.name === 'readOnly');
    const touchPlain = methods.find((n) => n.name === 'touchPlain');
    expect(build && increment && readOnly && touchPlain).toBeTruthy();

    const callers = cg
      .getIncomingEdges(build!.id)
      .filter((e) => e.kind === 'calls');
    const callerIds = callers.map((e) => e.source);
    expect(callerIds).toContain(increment!.id);
    expect(callerIds).not.toContain(readOnly!.id);
    expect(callerIds).not.toContain(touchPlain!.id);

    // The bridged edge is labeled heuristic ArkUI state dispatch.
    const bridged = callers.find((e) => e.source === increment!.id);
    expect(bridged?.provenance).toBe('heuristic');
    expect((bridged?.metadata as Record<string, unknown>)?.synthesizedBy).toBe('arkui-state');

    // The annotation-less decoy class gets no bridge at all.
    const decoyBuild = methods.find((n) => n.qualifiedName === 'PlainBuilderHolder::build');
    expect(decoyBuild).toBeDefined();
    expect(
      cg.getIncomingEdges(decoyBuild!.id).filter((e) => e.kind === 'calls')
    ).toHaveLength(0);
  });
});

describe('Cangjie chained-attribute hard gate', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links .titleStyle() to the @Builder helper but never .fontSize() to a decoy function', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-gate-'));
    fs.writeFileSync(
      path.join(tmpDir, 'decoy.cj'),
      'package demo\n' +
        '\n' +
        '// Decoys named after framework attributes.\n' +
        'public func fontSize(v: Float64): Float64 { return v }\n' +
        'public func width(v: Int64): Int64 { return v }\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'helpers.cj'),
      'package demo\n' +
        '\n' +
        '@Builder\n' +
        'public func titleStyle(size: Int64): Unit {\n' +
        '    Text("styled")\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'page.cj'),
      'package demo\n' +
        '\n' +
        '@Component\n' +
        'class Page {\n' +
        '    func build(): Unit {\n' +
        '        Text("t")\n' +
        '            .fontSize(16.0)\n' +
        '            .titleStyle(24)\n' +
        '        Column { Text("c") }.width(100)\n' +
        '    }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const titleStyle = fns.find((n) => n.name === 'titleStyle');
    const build = cg.getNodesByKind('method').find((n) => n.name === 'build');
    expect(titleStyle && build).toBeTruthy();

    // The @Builder helper is the ONLY thing an attribute chain may reach.
    expect(cg.getOutgoingEdges(build!.id).map((e) => e.target)).toContain(titleStyle!.id);
    for (const decoyName of ['fontSize', 'width']) {
      const decoy = fns.find((n) => n.name === decoyName);
      expect(decoy).toBeDefined();
      expect(cg.getIncomingEdges(decoy!.id).filter((e) => e.kind === 'calls')).toHaveLength(0);
    }
  });

  it('keeps lowercase fluent chains resolving as ordinary method calls', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-fluent-'));
    fs.writeFileSync(
      path.join(tmpDir, 'fluent.cj'),
      'package demo\n' +
        '\n' +
        'class Builder {\n' +
        '    func withX(): Builder { return this }\n' +
        '    func finish(): Unit {}\n' +
        '}\n' +
        '\n' +
        'func makeBuilder(): Builder { return Builder() }\n' +
        '\n' +
        'func user(): Unit {\n' +
        '    makeBuilder().withX().finish()\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const methods = cg.getNodesByKind('method');
    const user = fns.find((n) => n.name === 'user');
    const targetIds = cg.getOutgoingEdges(user!.id).map((e) => e.target);
    expect(targetIds).toContain(fns.find((n) => n.name === 'makeBuilder')!.id);
    expect(targetIds).toContain(methods.find((n) => n.name === 'withX')!.id);
    expect(targetIds).toContain(methods.find((n) => n.name === 'finish')!.id);
  });
});

describe('Cangjie bridge freshness on sync', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('rebuilds the state→build bridge when a sync introduces the assignment', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-sync-'));
    const file = path.join(tmpDir, 'counter.cj');
    fs.writeFileSync(
      file,
      'package demo\n\n@Component\npublic class Counter {\n' +
        '    @State\n    var n: Int64 = 0\n' +
        '    func readOnly(): Int64 { return this.n }\n' +
        '    func build(): Unit { Text("v") }\n}\n'
    );
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const bridge = () =>
      cg
        .getNodesByKind('method')
        .filter((n) => n.name === 'build')
        .flatMap((b) => cg.getIncomingEdges(b.id))
        .filter((e) => (e.metadata as Record<string, unknown>)?.synthesizedBy === 'arkui-state');
    expect(bridge()).toHaveLength(0);

    // Edit: readOnly now assigns the reactive field.
    fs.writeFileSync(
      file,
      'package demo\n\n@Component\npublic class Counter {\n' +
        '    @State\n    var n: Int64 = 0\n' +
        '    func readOnly(): Int64 {\n        this.n = this.n + 1\n        return this.n\n    }\n' +
        '    func build(): Unit { Text("v") }\n}\n'
    );
    await cg.sync();
    expect(bridge()).toHaveLength(1);

    // And a second sync stays idempotent.
    await cg.sync();
    expect(bridge()).toHaveLength(1);
  });
});

describe('Cangjie external supertype records', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('parks unresolvable supertypes in unresolved_refs and keeps in-repo ones as edges', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-super-'));
    fs.writeFileSync(
      path.join(tmpDir, 'abilities.cj'),
      'package demo\n\n' +
        'open class BaseView {}\n\n' +
        'class HomeView <: BaseView {}\n\n' +   // in-repo supertype → edge
        'class MainAbility <: UIAbility {\n' +   // SDK supertype → parked record
        '    public init() { super() }\n' +
        '}\n'
    );
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // In-repo supertype resolves into a real extends edge.
    const base = cg.getNodesByKind('class').find((n) => n.name === 'BaseView');
    expect(cg.getIncomingEdges(base!.id).filter((e) => e.kind === 'extends')).toHaveLength(1);

    // The SDK supertype is parked as a record, and does NOT read as pending
    // work (the orphan sweep / status must not see an interrupted index).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(tmpDir, '.codegraph/codegraph.db'));
    const rows = db
      .prepare("SELECT reference_kind, reference_name FROM unresolved_refs")
      .all() as Array<{ reference_kind: string; reference_name: string }>;
    db.close();
    expect(rows).toEqual([{ reference_kind: 'extends', reference_name: 'UIAbility' }]);
    expect(cg.getPendingReferenceCount()).toBe(0);
  });
});

describe('Cangjie entry-registration files vs .gitignore', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('indexes hvigor-generated entry registrations even when gitignored', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-entryreg-'));
    // HarmonyOS templates gitignore the generated registration files.
    fs.writeFileSync(
      path.join(tmpDir, '.gitignore'),
      '**/ability_mainability_entry.cj\n**/module_**_entry.cj\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'ability_stage.cj'),
      'package demo\n\nclass MyAbilityStage <: AbilityStage {}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'module_entry_entry.cj'),
      'package demo\n\nimport kit.AbilityKit.AbilityStage\n\n' +
        'let ENTRY_STAGE_REGISTER_RESULT = AbilityStage.registerCreator("entry", {=> MyAbilityStage()})\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // The registration binding exists as a symbol, and the entry hop links.
    const reg = cg.getNodesByKind('constant').find((n) => n.name === 'ENTRY_STAGE_REGISTER_RESULT');
    expect(reg).toBeDefined();
    const stage = cg.getNodesByKind('class').find((n) => n.name === 'MyAbilityStage');
    expect(stage).toBeDefined();
    expect(
      cg.getIncomingEdges(stage!.id).some((e) => e.kind === 'instantiates' && e.source === reg!.id)
    ).toBe(true);
  });
});
