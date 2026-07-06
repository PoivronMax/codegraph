# Vendored tree-sitter-cangjie

Source: https://gitcode.com/Cangjie-SIG/tree-sitter-cangjie (tag `1.1.0`), MIT license.

Vendored files:
- `src/parser.c`, `src/grammar.json`, `src/node-types.json`, `src/tree_sitter/*.h` —
  copied verbatim from the upstream repository (parser.c is the pre-generated
  parser, ABI 14).
- `src/scanner.c` — a C port of upstream's `scanner.rs` (the external scanner
  for multi-line raw strings `#"..."#`). Ported because the WASM build for
  web-tree-sitter links C scanners; the original Rust scanner only links into
  cargo builds.

Build output `tree-sitter-cangjie.wasm` is copied to `src/extraction/wasm/`
in the codegraph tree. To rebuild, run `./build-wasm.sh` (requires Docker or
a local emscripten install; uses the tree-sitter CLI via npx).
