# Theme — Bell Canada visual system

The operator UI is themed after an **iconic 1980s Bell Canada outdoor
phone booth** with a Northern Electric **Contempra** rotary phone tucked
inside. The booth is the chrome; the phone is the navigation.

## Palette

| Token             | Hex       | Use                                                              |
| ----------------- | --------- | ---------------------------------------------------------------- |
| `--bell-red`      | `#D81E2C` | Booth exterior frame around the entire app shell                  |
| `--enamel-white`  | `#F5F1E8` | "TELEPHONE" banner background, headings on red                   |
| `--bell-blue`     | `#0033A0` | **Bell Canada hex logo only.** Reserved for iconicity.            |
| `--aluminum`      | `#B8BCC2` | Door rails, hinges, coin-return shelf, card frames                |
| `--aluminum-dark` | `#7C8189` | Aluminum shadow + brushed-grain stroke                            |
| `--glass-blue`    | `#C9DBE3` | Frosted-glass content panels (35% opacity over noise texture)     |
| `--bakelite`      | `#15141A` | Phone body shadow, handset cradle                                 |
| `--beige`         | `#E8DCC4` | Contempra phone body + handset                                    |
| `--lamp-red`      | `#FF2A2A` | "recording" ceiling lamp                                          |
| `--lamp-amber`    | `#FFB300` | "playing" ceiling lamp                                            |
| `--lamp-green`    | `#1FAF5C` | "idle" ceiling lamp                                               |

All tokens live in `packages/web/src/styles/theme.css` as CSS custom
properties so the rest of the UI never sees raw hex. The operator Settings
screen only toggles classes/data attributes for font size and contrast; it
reuses these tokens rather than adding new palette values.

## Don'ts

- **Don't use Bell blue anywhere except the hex logo.** Its job is to
  make the logo unmistakable; spreading it dilutes that.
- **Don't replace the booth red** with a "modern" red. The exact 1980s
  shade is part of the joke.
- **Don't add additional decorative typefaces.** Keep the hierarchy
  tight (see Typography below).

## Typography

| Use                       | Family                          | Notes                                            |
| ------------------------- | ------------------------------- | ------------------------------------------------ |
| `TELEPHONE` banner        | Custom condensed sans (`Bell Sign`) | Hand-built to mimic 1980s Bell Canada signage  |
| Section headings          | Cooper Black                    | Booth-signage character                          |
| Body                      | Inter (Helvetica fallback)      | Era-appropriate (Helvetica was already iconic)   |
| Status terminal, timestamps | IBM Plex Mono                 | CRT/teletype feel for live-data panels           |

Fonts are self-hosted under `packages/web/src/styles/fonts/` so the
deployment has no third-party font dependency at runtime.

## Components

| Component            | Where                                                | Notes                                                                |
| -------------------- | ---------------------------------------------------- | -------------------------------------------------------------------- |
| `<BoothFrame>`       | Outermost shell                                      | Bell-red exterior + aluminum rails on every page                      |
| `<TelephoneBanner>`  | Top of every page                                    | White enamel sign + Bell hex logo (blue, the one place blue lives)    |
| `<ContempraPhone>`   | Sidebar / dashboard                                  | Inline SVG of the Northern Electric Contempra phone                   |
| `<RotaryDial>`       | Inside `<ContempraPhone>` face                       | Spring animation on rotate-and-return; primary navigation             |
| `<Handset>`          | Login screen + small in-header indicator             | Draggable; drop into cradle to log in (triggers OIDC redirect)        |
| `<CeilingLamps>`     | Top-inside of the booth, behind the banner           | Animated red/amber/green based on `BoothStatus`                       |
| `<LineBusyPlacard>`  | Slides in on WebSocket disconnect                    | "LINE BUSY" enamel placard + faint condensation on the glass          |
| `<GlassPanel>`       | Wraps every content card                             | Frosted-glass background + brushed-aluminum frame                     |

## Motion

- Rotary dial uses a CSS spring (`cubic-bezier(.34,1.56,.64,1)`)
  on rotate-back. Each "click" plays a 60 ms sample from
  `src/sounds/dial-click.flac` via `<audio>`. There's a mute toggle in
  Settings that persists to localStorage.
- Page transitions: 200 ms dial-tone hum + a single soft click.
- All motion respects `prefers-reduced-motion: reduce` — the rotary
  becomes a static SVG with normal `<button>` semantics, dial clicks +
  hum are muted, and the WS-disconnect condensation animation is
  disabled.

## Accessibility

The rotary dial is decoration. A standard, keyboard-navigable
**sidebar** with the same routes is always rendered — visible to
screen readers and to anyone hitting `Tab`. Numeric key shortcuts
(`1` through `9`, `0`) mirror the rotary digits. A "Skip to
content" link is first in tab order.

Decorative SVGs (booth chrome, phone body) are `aria-hidden`. Focus
rings are high-contrast `--aluminum-dark` on `--bell-red` (verified
≥ 4.5:1). Every text/background pair in the palette is independently
verified ≥ 4.5:1 for body text, ≥ 3:1 for large text.

## Sound assets

| File                                | Use                                  |
| ----------------------------------- | ------------------------------------ |
| `sounds/dial-click.flac`            | Per-step rotary click                |
| `sounds/dial-tone.flac`             | Page transition + login screen ambient |
| `sounds/ring.flac`                  | New pending message alert            |
| `sounds/line-busy.flac`             | WebSocket disconnect                 |
| `sounds/handset-pickup.flac`        | Login screen drag-to-answer          |

All assets are < 50 KB each. Loaded lazily so the initial paint isn't
blocked.
