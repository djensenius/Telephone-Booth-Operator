# Analytics

The operator UI deliberately presents **pickups** separately from **actions**.
In the API and shared schemas, the same pickup metric still uses the exact
field name `interactions`. In other words, one `interaction` in code is one
handset pickup (`CallSession`) in the UI, while actions are the individual dial
and playback attempts that happened during or around those pickups.

This keeps the questions honest:

- "How many people picked up the phone?" -> pickups (`interactions`)
- "How many times did people try a wrong number?" -> actions
- "How many messages were left?" -> pickup outcomes

Repeated actions do **not** have to sum to pickups. One visitor can dial
several digits, start playback more than once, or hang up without selecting
anything.

## Range semantics

Different metrics cohort on different timestamps by design:

| Surface                                                                                             | Cohort                                                              |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `StatsOverview.interactions.*`                                                                      | `CallSession.startedAt` in the selected range                       |
| `StatsOverview.actions.*`                                                                           | `BoothEvent.occurredAt` in the selected range                       |
| `StatsOverview.interactions.inProgressNow`                                                          | Live scoped count where `endedAt = null`                            |
| `StatsSummary.interactions.*`                                                                       | Current local-day `CallSession.startedAt` counts                    |
| `MonitorSummary.messagePlaybackStartsTotal`                                                         | All active-installation `BoothEvent` playback-start transitions     |
| `MonitorSummary.breakdownToday.noSelection/messagesLeft`                                            | Current local-day `CallSession.startedAt` cohort                    |
| `MonitorSummary.breakdownToday.wrongNumberAttempts/messagePlaybackStarts/instructionPlaybackStarts` | Current local-day `BoothEvent.occurredAt` cohort                    |
| `Installation.summary.interactions*`                                                                | The installation's full frozen `CallSession` / `BoothEvent` history |

The deprecated `StatsOverview.calls` object intentionally keeps its older
behavior for compatibility: some fields still cohort by `endedAt`, while the
new `interactions` object is fully start-cohort consistent.

## Pickup outcomes

The operator API keeps the raw `CallOutcome` distribution visible, but the
headline pickup breakouts are intentionally narrower:

| Field                       | Definition                                             |
| --------------------------- | ------------------------------------------------------ |
| `noSelection`               | `outcome = "hung_up_before_dial"`                      |
| `messagesLeft`              | `outcome = "recording_completed"`                      |
| `messagePlaybackStarts`     | `state_transition.payload.to = "playing_message"`      |
| `instructionPlaybackStarts` | `state_transition.payload.to = "playing_instructions"` |
| `wrongNumberAttempts`       | `digit_dialed` digits `3` through `9`                  |

`aborted`, `installation_ended`, upload failures, and other outcomes still
appear in the raw outcome distribution, but they are not folded into
`noSelection`.

`MonitorSummary.messagePlaybackStartsTotal` uses the same playback-start
predicate as `messagePlaybackStarts`, but it counts the entire active
installation instead of only the current local day.

## Action counting rules

`StatsOverview.actions.digitsDialed` is the authoritative per-digit histogram
for new clients. It uses persisted `digit_dialed` events only and is always
zero-filled for digits `0` through `9`.

Named action counters are derived from those events:

- `1` -> `leaveMessageSelections`
- `2` -> `listenMessageSelections`
- `0` -> `instructionSelections`
- `3` through `9` -> `wrongNumberAttempts`

Malformed event payloads are ignored rather than guessed. The API never
fabricates playback from a dialed digit, and it never fabricates a digit or
playback attempt from a session summary.

The deprecated `pickupsHangups.digitsDialed` histogram keeps the old surface
alive, but its fallback is stricter now:

1. If the selected range has any `digit_dialed` events, the legacy histogram
   uses those events only.
2. Only when the range has **no** digit events does it fall back to the
   historical `CallSession.digitsDialed` summary string.

That prevents legacy mixed-version datasets from double-counting the same
digits.

## Frozen installation summaries and backfill

Ended installations freeze a compact `summary` JSON blob so history screens do
not have to re-aggregate the event table on every load. New summaries now
include:

- `interactions`
- `interactionBreakdown`
- the existing deprecated `calls` alias

Historical rows frozen before this rollout still deserialize, but they need the
summary backfill to populate the new frozen pickup breakdown accurately.
Until the backfill runs, old summaries may carry compatibility aliases with a
zeroed breakdown.

Runbook instructions and exact commands live in [runbook](runbook.md). The
short version is:

```sh
just backfill-installation-summaries
just backfill-installation-summaries-apply
```

## Compatibility policy

The API keeps the legacy `calls` names alongside `interactions` during the
compatibility window:

- `StatsSummary.calls` alongside `StatsSummary.interactions`
- `MonitorSummary.callsToday` / `callsTotal` alongside
  `interactionsToday` / `interactionsTotal`
- `InstallationSummary.calls` alongside `InstallationSummary.interactions`
- `StatsOverview.hourly[].calls` and `boothBreakdown[].calls` alongside
  `interactions`

OpenAPI marks the legacy properties as deprecated where a replacement exists.
