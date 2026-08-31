# Exhibition report

The exhibition report CLI reads the existing operator API and writes a
standalone HTML report suitable for printing or saving as a PDF. It does not
connect to Postgres and does not require a reporting API endpoint.

The report includes:

- installation totals and local-calendar-day counts for interactions, messages
  left, messages approved, and message playback starts;
- every question with its total and approved answer counts;
- every answer and available transcription for the question matching
  `What name would you give this space as it exists now?`.

## Authentication

Set the operator API URL and one authenticated operator credential:

```sh
export OPERATOR_API_URL=https://operator.example.com
export OPERATOR_TOKEN=replace-with-an-oidc-operator-access-token
```

`OPERATOR_TOKEN` must be an OIDC operator bearer token, not a static booth API
token. To use an existing browser session instead, provide the raw cookie
header:

```sh
export OPERATOR_COOKIE='replace-with-the-authenticated-cookie-header'
```

The value may be either the complete
`__Host-booth_session=<value>` pair or just the value copied from the browser;
the CLI adds the production cookie name when it is omitted.

The CLI also accepts `PUBLIC_API_URL` or the phone client's
`BOOTH_OPERATOR_BASE_URL` when `OPERATOR_API_URL` is not set. The phone
client's `BOOTH_OPERATOR_TOKEN` cannot be reused: it is a static booth token,
while report endpoints require an OIDC operator token or session cookie.
Credentials are read only into request headers and are never written to the
report. The API URL must use HTTPS, except for explicit loopback development
addresses such as `http://localhost`.

If the variables already live in another local env file, load it directly:

```sh
pnpm --filter @telephone-booth-operator/api run report:exhibition -- \
  --load-env ../env
```

When `--load-env` is supplied, report connection variables come only from that
file. The CLI does not mix missing credentials or API URLs with variables from
the current process, so the file must contain both the API URL and the selected
operator credential.

## Generate the report

```sh
just exhibition-report
```

The `just` recipe defaults to the sibling `../env` file used by the
Telephone-Booth checkout. Pass a different path as its only argument when
needed:

```sh
just exhibition-report /path/to/operator.env
```

The default scope is the active installation and the default calendar time zone
is `America/Toronto`. Output is written under `reports/`, which is ignored by
Git because reports can contain visitor transcripts. Files are created with
owner-only permissions.

Useful options:

```sh
pnpm --filter @telephone-booth-operator/api run report:exhibition -- \
  --load-env ../env \
  --installation 00000000-0000-4000-8000-000000000000
pnpm --filter @telephone-booth-operator/api run report:exhibition -- \
  --load-env ../env \
  --time-zone America/Vancouver
pnpm --filter @telephone-booth-operator/api run report:exhibition -- \
  --load-env ../env \
  --title "Telephone Booth at Example Gallery"
pnpm --filter @telephone-booth-operator/api run report:exhibition -- \
  --load-env ../env \
  --output reports/example-gallery.html
pnpm --filter @telephone-booth-operator/api run report:exhibition -- \
  --load-env ../env \
  --transcript-question "What name would you give this space as it exists now?"
```

Run
`pnpm --filter @telephone-booth-operator/api run report:exhibition -- --help`
for the complete option list.

Open the generated HTML file in a browser and use **Print / Save PDF**. The
print stylesheet uses letter-sized pages, repeats table headers, and starts the
transcript section on a new page.

## Counting rules

The report follows the definitions in [Analytics](analytics.md):

| Report label         | API definition                                                      |
| -------------------- | ------------------------------------------------------------------- |
| Interactions         | Call sessions grouped by `startedAt`                                |
| Messages left        | Interactions with outcome `recording_completed`                     |
| Messages approved    | Messages whose current status is `approved`, grouped by `createdAt` |
| Messages listened to | State transitions whose destination is `playing_message`            |

The CLI requests `/v1/stats/overview` once for the installation total and once
for each local calendar day. Question and transcript detail comes from the
cursor-paginated question, question-message, and transcription endpoints.
Question answer counts use message `createdAt` values inside the same report
window as the overview metrics. The CLI enumerates questions across all
installation eras, then includes the selected installation's questions plus
any earlier question that has an in-range message assigned to the selected
installation.

The current overview endpoint can aggregate at most 5,000 recordings. The CLI
refuses to write a report when the response reaches that boundary, because
completeness cannot be guaranteed without an uncapped reporting API.
