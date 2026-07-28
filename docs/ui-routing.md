# UI routing

The operator UI's primary navigation is the always-present sidebar. Each
route keeps a digit prefix so operators can use fast numeric shortcuts
without needing a decorative rotary control.

## Digit shortcut map

| Digit | Route                 | Purpose                                                   |
| ----- | --------------------- | --------------------------------------------------------- |
| **1** | `/status`             | Live status panel (the default landing route)             |
| **2** | `/messages`           | Message review queue                                      |
| **3** | `/questions`          | Manage the question library                               |
| **4** | `/tokens`             | API token lifecycle and usage (**admin-only**)            |
| **5** | `/settings`           | Operator account, theme, and phone-client connection      |
| **6** | `/about`              | Console context, credits, version, license                |
| **7** | `/login` after logout | Clear the operator session / auth line                    |
| **8** | `/instructions`       | Manage the booth instructions clip (**admin-only**)       |
| **9** | `/debug`              | Phone-booth debug surface (LAN/Tailscale, **admin-only**) |
| **0** | `/`                   | Home (Status)                                             |

Routes are reachable via direct numeric shortcuts: press `1`–`9` or `0`
from any non-input context to navigate. The sidebar shows the same digit
prefixes for keyboard and screen-reader users. Admin-only routes
(`/tokens`, `/instructions`, `/debug`) are greyed out in the sidebar and their digit/chord
shortcuts are ignored for non-admin operators.

## Routes deeper than digits

| Route                           | Notes                                                              |
| ------------------------------- | ------------------------------------------------------------------ |
| `/login`                        | Public OIDC login launcher                                         |
| `/messages?status=needs-review` | Recordings still awaiting a human verdict (`received` + `pending`) |
| `/messages?status=approved`     | Filter the queue to approved recordings                            |
| `/messages?status=rejected`     | Filter the queue to rejected recordings                            |
| `/messages?status=uploading`    | Filter uploads still in progress                                   |
| `/messages/:id`                 | Single-message review screen with audio player                     |
| `/questions/new`                | Open the new-question upload flow                                  |
| `/tokens`                       | API token CRUD and usage sparklines                                |
| `/settings`                     | Account, theme, and phone-client connection                        |
| `/about`                        | Public lore and credits page                                       |
| `/debug`                        | Debug panel for the configured phone client                        |
| `/v1/auth/callback`             | API OIDC callback handler                                          |

An unrecognized `status` value falls back to the unfiltered queue. The
`needs-review` filter spans two backend statuses, so it is narrowed in the
browser rather than passed through as `?status=` to `GET /v1/messages`.

## Message queue

`/messages` renders one card per recording — inline playback, the linked
question, transcript, AI moderation verdict, and the operator's own
Approve/Reject controls. Decisions can be made directly from the queue or from
the single-message screen. The AI verdict is always advisory — the recorded
decision is the operator's.

Transcription state is push-aware: when `AI_TRANSCRIPTION_PROVIDER=push` a
queued job reads "Waiting on transcription device" rather than "Transcribing…",
because the work happens in the Transcription app rather than on the API. See
[`transcription-providers.md`](transcription-providers.md).

## Reduced motion

When `prefers-reduced-motion: reduce` is set, interface transitions and
status animations are minimized. Sound effects are muted by default;
users can opt back in via Settings.

## Keyboard shortcuts

| Key          | Action                                              |
| ------------ | --------------------------------------------------- |
| `1`..`9`,`0` | Navigate to the matching digit route                |
| `?`          | Open shortcuts help dialog                          |
| `/`          | Focus the search/filter input on the current screen |
| `g s`        | Go to Status (alias for `1`)                        |
| `g q`        | Go to Questions (alias for `3`)                     |
| `g d`        | Go to Debug (alias for `9`)                         |
| `Esc`        | Close any open modal / drawer                       |
