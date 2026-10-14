/**
 * Cangjie end-to-end resolution tests.
 *
 * Pins the package/import contract: every top-level declaration lives under
 * its file's `package` namespace (`demo.model::User`), and an `import
 * demo.model.User` binds `User` to exactly that FQN — a same-named class in
 * another package is never the target. Also pins that a call on a local of a
 * standard-library type (`let list = ArrayList<…>(); list.add(x)`) never
 * lands on a project method that merely shares the name.
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

describe('Cangjie package/import resolution', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(tmpDir!, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir!, rel), text);
  };

  it('binds an imported class and its method to the imported package, not a same-named decoy', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    write('src/model/user_model.cj',
      'package demo.model\n\n' +
      'public class User {\n' +
      '    public init(name: String) {}\n' +
      '    public func greet(): String { "hi" }\n' +
      '}\n');
    // A decoy with the same class and method names in another package.
    write('src/other/decoy.cj',
      'package demo.other\n\n' +
      'public class User {\n' +
      '    public func greet(): String { "decoy" }\n' +
      '}\n');
    write('src/app/main.cj',
      'package demo.app\n\n' +
      'import demo.model.User\n\n' +
      'public func run(): String {\n' +
      '    let u = User("a")\n' +
      '    u.greet()\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const byQn = (qn: string) =>
      [...cg!.getNodesByKind('class'), ...cg!.getNodesByKind('method'), ...cg!.getNodesByKind('function')]
        .find((n) => n.qualifiedName === qn);
    const run = byQn('demo.app::run');
    const user = byQn('demo.model::User');
    const greet = byQn('demo.model::User::greet');
    const decoy = byQn('demo.other::User');
    const decoyGreet = byQn('demo.other::User::greet');
    expect(run && user && greet && decoy && decoyGreet).toBeTruthy();

    const out = cg.getOutgoingEdges(run!.id);
    expect(out.find((e) => e.target === user!.id)?.kind).toBe('instantiates');
    expect(out.find((e) => e.target === greet!.id)?.kind).toBe('calls');
    expect(cg.getIncomingEdges(decoy!.id).filter((e) => e.kind !== 'contains')).toHaveLength(0);
    expect(cg.getIncomingEdges(decoyGreet!.id).filter((e) => e.kind === 'calls')).toHaveLength(0);

    // The import itself resolves to the imported class.
    const importEdges = cg.getIncomingEdges(user!.id).filter((e) => e.kind === 'imports');
    expect(importEdges.length).toBeGreaterThan(0);
  });

  it('never links a std-collection call to a same-named project method', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    write('src/coll/empty.cj',
      'package demo.coll\n\n' +
      'public class EmptyList {\n' +
      '    public func add(x: Int64): Unit {}\n' +
      '}\n');
    write('src/app/fill.cj',
      'package demo.app\n\n' +
      'import std.collection.*\n\n' +
      'public func fill(): Unit {\n' +
      '    let list = ArrayList<Int64>()\n' +
      '    list.add(1)\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const add = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'demo.coll::EmptyList::add');
    expect(add).toBeDefined();
    expect(cg.getIncomingEdges(add!.id).filter((e) => e.kind === 'calls')).toHaveLength(0);
  });
});
