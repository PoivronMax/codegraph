/**
 * External scanner for Cangjie multi-line raw strings.
 *
 * C port of the upstream Rust scanner (scanner.rs) from
 * https://gitcode.com/Cangjie-SIG/tree-sitter-cangjie (tag 1.1.0, MIT).
 * Ported to C so the grammar can be compiled to WASM for web-tree-sitter
 * (the emscripten toolchain links C scanners; the original Rust scanner
 * only links into cargo builds).
 *
 * Handles multi-line raw string literals of the form #"...content..."#
 * where the number of '#' characters must match between the opening and
 * closing delimiters.
 *
 * Token indices must match the `externals` order in grammar.js:
 *   0. _multiLineRawStringStart   - opening delimiter #+"
 *   1. _multiLineRawStringContent - string content
 *   2. _multiLineRawStringEND     - closing delimiter "#+
 */

#include "tree_sitter/parser.h"
#include <stdlib.h>
#include <string.h>

enum TokenType {
  MULTI_LINE_RAW_STRING_START,
  MULTI_LINE_RAW_STRING_CONTENT,
  MULTI_LINE_RAW_STRING_END,
};

typedef struct {
  bool in_string;
  uint8_t delimiter_length;
} Scanner;

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer) { lexer->advance(lexer, true); }

/* Count and consume consecutive characters matching `ch` (max 255). */
static uint8_t count_and_consume(TSLexer *lexer, int32_t ch) {
  uint8_t count = 0;
  while (lexer->lookahead == ch && count < UINT8_MAX) {
    advance(lexer);
    count++;
  }
  return count;
}

/* Opening delimiter: #+" */
static bool scan_opening_delimiter(Scanner *s, TSLexer *lexer) {
  uint8_t hash_count = count_and_consume(lexer, '#');

  if (hash_count == 0 || lexer->lookahead != '"') {
    s->delimiter_length = 0;
    s->in_string = false;
    return false;
  }

  advance(lexer); // consume '"'
  s->delimiter_length = hash_count;
  s->in_string = true;
  lexer->result_symbol = MULTI_LINE_RAW_STRING_START;
  return true;
}

/* Closing delimiter: "#+ */
static bool scan_closing_delimiter(Scanner *s, TSLexer *lexer) {
  advance(lexer); // consume '"'

  uint8_t hash_count = count_and_consume(lexer, '#');

  if (hash_count != s->delimiter_length) {
    // Not a valid closing delimiter
    return false;
  }

  s->delimiter_length = 0;
  s->in_string = false;
  lexer->result_symbol = MULTI_LINE_RAW_STRING_END;
  return true;
}

/* String content until (but not including) the closing delimiter.
 *
 * The Rust original clones the lexer to look ahead past a '"' without
 * consuming; TSLexer can't be cloned in C, so on a non-closing quote the
 * quote and its trailing '#'s stay consumed and scanning continues — they
 * are content either way, and mark_end() is only ever latched before a
 * quote that proves to be a real closing delimiter (or at EOF). */
static bool scan_string_content(Scanner *s, TSLexer *lexer) {
  if (!s->in_string) {
    return false;
  }

  lexer->result_symbol = MULTI_LINE_RAW_STRING_CONTENT;
  lexer->mark_end(lexer);

  for (;;) {
    if (lexer->lookahead == '"') {
      lexer->mark_end(lexer); // content ends before this quote
      advance(lexer);
      uint8_t hash_count = count_and_consume(lexer, '#');
      if (hash_count == s->delimiter_length) {
        // Real closing delimiter: return content up to the quote
        return true;
      }
      // Not a closing delimiter — the quote and hashes are content
      lexer->mark_end(lexer);
    } else if (lexer->lookahead == 0 && lexer->eof(lexer)) {
      lexer->mark_end(lexer);
      return true;
    } else {
      advance(lexer);
      lexer->mark_end(lexer);
    }
  }
}

static inline bool is_ascii_whitespace(int32_t c) {
  return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f';
}

// ============================================================================
// Entry points required by tree-sitter
// ============================================================================

void *tree_sitter_cangjie_external_scanner_create(void) {
  Scanner *s = calloc(1, sizeof(Scanner));
  return s;
}

void tree_sitter_cangjie_external_scanner_destroy(void *payload) {
  free(payload);
}

unsigned tree_sitter_cangjie_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = payload;
  buffer[0] = s->in_string ? 1 : 0;
  buffer[1] = (char)s->delimiter_length;
  return 2;
}

void tree_sitter_cangjie_external_scanner_deserialize(void *payload, const char *buffer,
                                                      unsigned length) {
  Scanner *s = payload;
  if (buffer != NULL && length >= 2) {
    s->in_string = buffer[0] != 0;
    s->delimiter_length = (uint8_t)buffer[1];
  } else {
    s->in_string = false;
    s->delimiter_length = 0;
  }
}

bool tree_sitter_cangjie_external_scanner_scan(void *payload, TSLexer *lexer,
                                               const bool *valid_symbols) {
  Scanner *s = payload;

  // Skip leading whitespace (only relevant before an opening delimiter)
  if (!s->in_string) {
    while (is_ascii_whitespace(lexer->lookahead)) {
      skip(lexer);
    }
  }

  if (valid_symbols[MULTI_LINE_RAW_STRING_START] && !s->in_string &&
      lexer->lookahead == '#') {
    return scan_opening_delimiter(s, lexer);
  }

  if (valid_symbols[MULTI_LINE_RAW_STRING_CONTENT] && s->in_string) {
    return scan_string_content(s, lexer);
  }

  if (valid_symbols[MULTI_LINE_RAW_STRING_END] && s->in_string &&
      lexer->lookahead == '"') {
    return scan_closing_delimiter(s, lexer);
  }

  return false;
}
