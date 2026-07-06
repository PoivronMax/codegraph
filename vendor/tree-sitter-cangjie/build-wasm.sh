#!/usr/bin/env bash
# Rebuild tree-sitter-cangjie.wasm from the vendored grammar sources and copy
# it into src/extraction/wasm/ (npm run build then ships it into dist/).
#
# Requirements: node >= 20 (for npx) and EITHER a local emscripten (emcc on
# PATH) OR a running Docker daemon — the tree-sitter CLI falls back to the
# emscripten/emsdk Docker image automatically when emcc is absent.
set -euo pipefail
cd "$(dirname "$0")"

npx -y tree-sitter-cli@0.25.8 build --wasm -o tree-sitter-cangjie.wasm .
cp tree-sitter-cangjie.wasm ../../src/extraction/wasm/tree-sitter-cangjie.wasm
echo "Built and copied tree-sitter-cangjie.wasm ($(wc -c < tree-sitter-cangjie.wasm) bytes)"
