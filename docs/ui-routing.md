# UI routing

The operator UI's primary navigation is the rotary dial set into the
Contempra phone. Each digit routes you somewhere different.

## Rotary digit map

| Digit | Route       | Purpose                                       |
| ----- | ----------- | --------------------------------------------- |
| **1** | `/status`   | Live status panel (the default landing route) |
| **2** | `/messages` | Message review queue                          |
| **3** | `/questions`| Manage the question library                   |
| **4** | `/tokens`   | API token lifecycle and usage                 |
| **5** | `/settings` | Operator account, theme, and phone-client connection |
| **6** | `/about`    | Operator lore, credits, version, license      |
| **7** | `/login` after logout | Clear the operator session / auth line |
| **8** | _reserved_  | (future)                                      |
| **9** | `/debug`    | Phone-booth debug surface (LAN/Tailscale)     |
| **0** | `/`         | Home (Status)                                 |

Routes are also reachable via the **always-present sidebar** (keyboard
nav, screen-reader friendly) and via direct numeric shortcuts:
press `1`–`9` or `0` from any non-input context to navigate. The hook
position is displayed around every route through the booth shell status
lamps and Status screen receiver indicator.

## Routes deeper than digits

| Route                          | Notes                                              |
| ------------------------------ | -------------------------------------------------- |
| `/login`                       | Public OIDC login launcher                         |
| `/messages?status=received`    | Filter the queue to received recordings            |
| `/messages?status=uploading`   | Filter uploads still in progress                   |
| `/messages?status=failed`      | Filter failed/rejected recordings                  |
| `/messages/:id`                | Single-message review screen with audio player     |
| `/questions/new`               | Open the new-question upload flow                  |
| `/tokens`                      | API token CRUD and usage sparklines                |
| `/settings`                    | Account, theme, and phone-client connection        |
| `/about`                       | Public lore and credits page                       |
| `/debug`                       | Debug panel for the configured phone client        |
| `/v1/auth/callback`            | API OIDC callback handler                          |

## Reduced motion

When `prefers-reduced-motion: reduce` is set:

- Rotary dial renders as static SVG buttons; clicking still navigates.
- No spring animation, no dial-tone hum, no condensation on the glass.
- Sound effects are muted by default; users can opt back in via
  Settings.

## Keyboard shortcuts

| Key      | Action                          |
| -------- | ------------------------------- |
| `1`..`9`,`0` | Navigate to the matching rotary route |
| `?`      | Open shortcuts help dialog       |
| `/`      | Focus the search/filter input on the current screen |
| `g s`    | Go to Status (alias for `1`)    |
| `g q`    | Go to Questions (alias for `3`) |
| `g d`    | Go to Debug (alias for `9`)     |
| `Esc`    | Close any open modal / drawer    |
