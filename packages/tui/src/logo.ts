// Pile Code wordmark for the TUI home screen.
//
// Four rows, two blocks (left = PILE, right = CODE), rendered by
// component/logo.tsx. `_` = shadow space, `^`/`~` = upper half block, `,` =
// lower half block. Keep every row the same width so the wordmark stays aligned
// at narrow terminal widths.
export const logo = {
  left: [
    "█▀▀█ █ █   █▀▀▀",
    "█__█ █ █   █▀▀▀",
    "█▀▀▀ █ █   █▄▄▄",
    "▀    ▀ ▀▀▀ ▀▀▀▀",
  ],
  right: [
    "█▀▀█ █▀▀█ █▀▀▄ █▀▀▀",
    "█___ █__█ █__█ █▀▀▀",
    "█___ █__█ █__█ █▄▄▄",
    "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀",
  ],
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}
