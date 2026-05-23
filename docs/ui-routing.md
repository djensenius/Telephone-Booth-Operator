# UI routing

The operator UI's primary navigation is the rotary dial set into the
Contempra phone. Each digit routes you somewhere different.

## Rotary digit map

| Digit | Route                | Purpose                                       |
| ----- | -------------------- | --------------------------------------------- |
| **1** | `/status`            | Live status panel (the default landing route) |
| **2** | `/messages?status=pending` | Pending messages to review              |
| **3** | `/messages?status=approved`| Approved messages                       |
| **4** | `/messages?status=rejected`| Rejected messages                       |
| **5** | `/questions`         | Manage the question library                   |
| **6** | `/settings`          | Operator settings (incl. API tokens)          |
| **7** | _reserved_           | (future)                                      |
| **8** | _reserved_           | (future)                                      |
| **9** | `/debug`             | Phone-booth debug surface (LAN/Tailscale)     |
| **0** | `/about`             | Operator, credits, version, license           |

Routes are also reachable via the **always-present sidebar** (keyboard
nav, screen-reader friendly) and via direct numeric shortcuts:
press `1`–`9` or `0` from any non-input context to navigate.

## Routes deeper than digits

| Route                          | Notes                                              |
| ------------------------------ | -------------------------------------------------- |
| `/messages/:id`                | Single-message review screen with audio player      |
| `/questions/new`               | Record a new question via browser MediaRecorder + upload as FLAC |
| `/settings/tokens`             | API token CRUD                                     |
| `/settings/account`            | Connected Authentik account info                    |
| `/debug/:boothId`              | Detailed debug for one booth (multi-booth support) |
| `/auth/callback`               | OIDC callback handler                              |

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
| `g q`    | Go to Questions (alias for `5`) |
| `g d`    | Go to Debug (alias for `9`)     |
| `Esc`    | Close any open modal / drawer    |
