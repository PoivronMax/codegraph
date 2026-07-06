# 仓颉 (Cangjie) 语言支持说明

本分支（`cangjie-support`）为 codegraph 增加了华为 HarmonyOS 应用语言仓颉（`.cj`）的索引支持：
`codegraph init` 会产出仓颉的 function/method/property/class/interface/struct/enum 节点
（含 `extend` 扩展块——成员按 Swift extension 先例挂到被扩展类型名下，`Widget::extended`），
以及 `calls`（调用，含无括号尾随 lambda 的 ArkUI DSL 写法）、`extends`/`implements`
（`<:` 超类型列表）、`instantiates`（构造）、`contains`、`imports` 边，写入
`.codegraph/codegraph.db`。原有全部语言不受影响（完整测试套件全部通过，仅上游自带的
一个 mcp-daemon 时序 flaky 测试偶发，未改动的上游 main 同样复现）。

## 改动的文件

| 文件 | 改动 |
|---|---|
| `vendor/tree-sitter-cangjie/` | **新增**。从 [Cangjie-SIG/tree-sitter-cangjie](https://gitcode.com/Cangjie-SIG/tree-sitter-cangjie)（tag 1.1.0，MIT）vendor 的语法：`src/parser.c`（预生成，ABI 14）、`src/grammar.json`、`src/node-types.json`、`src/tree_sitter/*.h` 原样复制；**`src/scanner.c` 是上游 Rust 外部扫描器（scanner.rs，仅处理多行原始字符串 `#"..."#`）的 C 移植**；另含 `tree-sitter.json`、`build-wasm.sh` 构建脚本与 `NOTICE.md` 来源声明 |
| `src/extraction/wasm/tree-sitter-cangjie.wasm` | **新增**。由上面的 vendor 源编译出的 wasm 语法（构建产物，已提交，与仓库里其他自带 wasm 一致） |
| `src/extraction/languages/cangjie.ts` | **新增**。仓颉的 `LanguageExtractor`：`functionDefinition`/`mainDefinition` → function（类体内自动归为 method），`init`/`operatorFunctionDefinition` → method（操作符函数名取符号，如 `operator +`），class/interface/struct/enum 定义各归其类；`prop` 属性由 `visitNode` 钩子整体接管（取 `propertyName` 命名 + 遍历 getter/setter 块提取访问器内的调用——核心的默认属性路径两者都做不到）；该语法不使用 tree-sitter field，名字（`funcName`/`className`/…）和函数体（`block`/`classBody`/…）都是具名子节点，因此通过 `resolveName`/`resolveBody` 钩子提取；另实现签名、可见性、static、import 提取 |
| `src/extraction/tree-sitter.ts` | ① `extractCall` 新增 cangjie 分支：调用点是挂在 `postfixExpression` 下的 `callSuffix`（`foo(x)`）或无括号尾随 lambda `trailingLambdaExpression`（`Column { … }`，ArkUI 主流写法，语法树里没有 callSuffix）；被调名由 `cangjieCalleeName`（cangjie.ts 导出）按**紧邻后缀的前一个命名兄弟**结构化判定——`obj.method(` → method、`svc?.start()` → start、`this(…)` → init（构造器委托）、`cb?()` → cb；计算型目标（`handlers[i]()`、柯里化 `f(a)(b)` 的第二段、lambda 立即调用）刻意静默不猜名字；带括号 + 尾随 lambda（`runTask(1) { … }`）不会重复发射；② `extractStruct` 补上 `resolveBody` 回退（core 里唯一没走该钩子的路径，无 field 语法的 struct 原本会被误判为前置声明而跳过） |
| `src/extraction/grammars.ts` | 注册 `.cj` → `cangjie`、wasm 文件名映射、本地 wasm 加载白名单、显示名 |
| `src/types.ts` | `LANGUAGES` 增加 `'cangjie'` |
| `src/extraction/languages/index.ts` | 注册 `cangjieExtractor` |
| `__tests__/extraction.test.ts` | 新增 10 个仓颉抽取测试（检测、函数/类/方法/init、interface/struct/enum、main、import、裸调用与点调用、方法体调用归属、raw string） |
| `CHANGELOG.md` | Unreleased 条目 |

## 仓颉语法是怎么编译/加载进去的

codegraph 用 **web-tree-sitter（纯 WASM）** 加载所有语法（`src/extraction/grammars.ts`），
大部分来自 `tree-sitter-wasms` npm 包，另有十余个仓库自带的 `.wasm` 放在
`src/extraction/wasm/`。仓颉走后一条路。

主要障碍是上游语法的外部扫描器是 **Rust** 写的（`scanner.rs`），而 tree-sitter 的
WASM 构建链（emscripten）只链接 C/C++ 扫描器。该扫描器只有约 300 行、仅负责多行原始
字符串 `#"..."#` 的词法（3 个 token + 2 字节可序列化状态），因此直接**移植成
`src/scanner.c`（约 180 行）**，之后就是标准流程：

```
tree-sitter build --wasm  →  emcc 编译 parser.c + scanner.c  →  tree-sitter-cangjie.wasm
```

parser.c 是上游预生成的（ABI 14），web-tree-sitter 0.25 支持 ABI 13–15，无需重新生成。
C 移植与 Rust 原版在真实工程上逐项一致（见下方验证）。

## 在新机器上复现构建

前置：Node ≥ 20；重编 wasm 时还需 Docker（运行中即可，tree-sitter CLI 自动用
emscripten/emsdk 镜像）或本地 emcc。

```bash
git clone <本分支仓库> && cd codegraph && git checkout cangjie-support
npm install
npm run build          # tsc + 把 schema.sql 与全部 wasm 拷进 dist/

# 仅当改了 vendor/tree-sitter-cangjie/src 下的语法/扫描器时才需要重编 wasm：
./vendor/tree-sitter-cangjie/build-wasm.sh   # 产出并拷贝 tree-sitter-cangjie.wasm，然后重跑 npm run build
```

## 验证命令与结果

```bash
cd <仓颉工程根目录>
node <codegraph仓库>/dist/bin/codegraph.js init

sqlite3 .codegraph/codegraph.db \
  "SELECT COUNT(*) FROM nodes WHERE language='cangjie' AND kind IN ('function','method');"
sqlite3 .codegraph/codegraph.db \
  "SELECT COUNT(*) FROM edges e JOIN nodes n ON e.source=n.id
   WHERE e.kind='calls' AND n.language='cangjie';"
```

在验收工程 `EUDI_Harmony`（158 个 .cj，排除 third_party/oh_modules/build 后）上的实测
（2026-07-06）：

| 指标 | 参考实现 cj-extract（同日同代码树） | 本分支 codegraph |
|---|---|---|
| .cj 文件数 | 158 | 158 |
| 函数/方法节点 | 2107（仅 `functionDefinition`） | **2488**（另含 `init` 构造器、struct 方法、`main`） |
| 调用边 | 10787（原始 caller→callee 名对，含无法解析的标准库调用） | **5248 条已解析 `calls` 边 + 1703 条 `instantiates`**（codegraph 只保留能解析到图内节点的边；构造调用被单独归类） |
| 解析失败文件（`hasError`） | 58 | 58（同一语法，逐项一致 —— 用本分支 wasm + C 扫描器重解析全部文件与 Rust 原版结果完全相同：158 文件 / 2107 个 `functionDefinition` / 58 个 error 文件） |

另附小样例（2 文件）核对：`greet → makeLine`、`topLevel → greet`、`main → topLevel`
三条 `calls` 边与 `main → Greeter` 的 `instantiates` 边均正确，类内 `func` 归为
method、`init` 归为 method、顶层 `func`/`main` 归为 function。

## 许可

上游 codegraph 与 Cangjie-SIG/tree-sitter-cangjie 均为 MIT；原 LICENSE 保留，
vendor 目录含 `NOTICE.md` 来源与修改声明。内部使用合规。
