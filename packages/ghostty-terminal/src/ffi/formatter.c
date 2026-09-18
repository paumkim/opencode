#include <ghostty/vt/formatter.h>
#include <ghostty/vt/point.h>

/* The pinned ABI is 64-bit. Never pass this by-value struct as a Bun ptr. */
_Static_assert(sizeof(void *) == 8, "64-bit pointers required");
_Static_assert(sizeof(size_t) == 8, "64-bit size_t required");
_Static_assert(sizeof(GhosttyResult) == 4, "32-bit result required");
_Static_assert(sizeof(GhosttyFormatterScreenExtra) == 16, "screen extra ABI");
_Static_assert(sizeof(GhosttyFormatterTerminalExtra) == 32, "terminal extra ABI");
_Static_assert(sizeof(GhosttyFormatterTerminalOptions) == 56, "options ABI");
_Static_assert(offsetof(GhosttyFormatterTerminalOptions, emit) == 8, "emit offset");
_Static_assert(offsetof(GhosttyFormatterTerminalOptions, unwrap) == 12, "unwrap offset");
_Static_assert(offsetof(GhosttyFormatterTerminalOptions, trim) == 13, "trim offset");
_Static_assert(offsetof(GhosttyFormatterTerminalOptions, extra) == 16, "extra offset");
_Static_assert(offsetof(GhosttyFormatterTerminalOptions, selection) == 48, "selection offset");
_Static_assert(offsetof(GhosttyFormatterTerminalExtra, screen) == 16, "screen offset");

/* Bun FFI cannot call APIs that take structs by value, and the selection plus
 * its grid refs must outlive the formatter. This adapter formats exactly the
 * visible viewport (what an agent's visual capture should see), not the
 * screen buffer including scrollback that a selection-less format returns. */
int ghostty_bun_format_screen(GhosttyTerminal terminal, bool html,
                              uint16_t cols, uint16_t rows,
                              uint8_t **out_ptr, size_t *out_len) {
    GhosttyPoint top = {0};
    GhosttyPoint bottom = {0};
    top.tag = GHOSTTY_POINT_TAG_VIEWPORT;
    bottom.tag = GHOSTTY_POINT_TAG_VIEWPORT;
    bottom.value.coordinate.x = cols - 1;
    bottom.value.coordinate.y = rows - 1;

    GhosttyGridRef start;
    GhosttyGridRef end;
    GhosttyResult result = ghostty_terminal_grid_ref(terminal, top, &start);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_terminal_grid_ref(terminal, bottom, &end);
    if (result != GHOSTTY_SUCCESS) return result;

    GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
    selection.start = start;
    selection.end = end;

    GhosttyFormatterTerminalOptions options = {0};
    options.size = sizeof(options);
    options.emit = html ? GHOSTTY_FORMATTER_FORMAT_HTML : GHOSTTY_FORMATTER_FORMAT_PLAIN;
    options.trim = true;
    options.selection = &selection;

    GhosttyFormatter formatter = NULL;
    result = ghostty_formatter_terminal_new(NULL, &formatter, terminal, options);
    if (result != GHOSTTY_SUCCESS) return result;
    result = ghostty_formatter_format_alloc(formatter, NULL, out_ptr, out_len);
    ghostty_formatter_free(formatter);
    return result;
}
