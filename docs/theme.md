# Theme — operator-console visual system

The operator UI is a polished control desk for the Telephone-Booth
installation. It uses a red telephone accent for warmth and recognition,
but the interface should stay task-first: clear navigation, readable
cards, useful status color, and minimal decorative chrome.

## Palette

All colors live as CSS custom properties in
`packages/web/src/styles/theme.css`. Components should reference tokens
instead of raw color values.

| Token family | Use |
| ------------ | --- |
| `--surface-*` | Page, panel, raised-card, muted, and inset surfaces |
| `--text-*` | Primary, secondary, muted, and on-accent text |
| `--accent-red*` | Product mark, primary actions, live recording/error emphasis |
| `--accent-green` | Healthy/approved/connected state |
| `--accent-yellow` | Pending/review/playing state |
| `--accent-blue`, `--accent-mauve`, `--accent-peach` | Secondary highlights and depth |
| `--border-*` | Subtle and strong borders |
| `--shadow-*` | Soft elevation and card shadows |

The palette is Catppuccin-inspired in spirit: soft dark surfaces, warm
text, and saturated accents. It is intentionally project-specific rather
than a direct Catppuccin copy. The default setting follows
`prefers-color-scheme`, and operators can choose system, dark, or light in
Settings.

## Brand and iconography

The app mark is a compact red rounded square with a simple `T` letterform for
the favicon. The header is intentionally text-first. Do not use legacy
telecom-style hex marks, mascot logos, or oversized signage wordmarks.

Decorative phone imagery should be small and purposeful. The default UI
does not render a rotary dial or large phone illustration; digit shortcuts
remain available through the sidebar and keyboard.

## Typography

| Use | Family | Notes |
| --- | ------ | ----- |
| Product display / empty states | Inter (`--font-display`) | Restrained display scale without novelty typography |
| Headings and UI labels | Inter (`--font-heading`) | Keeps screens functional and scannable |
| Body | Inter (`--font-body`) | Primary reading face |
| Status, timestamps, diagnostics | IBM Plex Mono (`--font-mono`) | Operator-console and log readouts |

Fonts are self-hosted under `packages/web/src/styles/fonts/`.

## Components

| Component | Role |
| --------- | ---- |
| `<BoothFrame>` | Outermost ambient background and page padding |
| `<TelephoneBanner>` | Compact app identity, mark, and descriptive tagline |
| `<BoothStatusBadge>` | Labeled booth state indicator in the sidebar |
| `<GlassPanel>` | Main content surface for routed screens |
| `<LineBusyPlacard>` | Disconnect/line-busy notification |

Cards, tables, forms, badges, and debug panels share the same semantic
surface/border/shadow tokens so feature screens feel consistent.

## Accessibility

- Normal sidebar navigation is always present and includes digit prefixes.
- Numeric shortcuts (`1` through `9`, `0`) mirror the sidebar routes.
- Focus rings use `--focus-ring` and must remain visible in dark and light
  modes.
- High-contrast mode keeps panel backgrounds solid and border contrast
  strong.
- `prefers-reduced-motion: reduce` minimizes transitions and status
  animations. Sound and motion overrides remain available in Settings.
