# Authentik onboarding — invite-only, passwordless enrollment

This guide sets up a **self-serve** operator onboarding flow in Authentik:
you create an invitation, send the recipient a link, and they enroll
themselves. Enrollment **forces a passkey** (WebAuthn discoverable
credential) and is **passwordless** — the passkey is the operator's only
credential. New users are added to the `telephone-booth-operators` group
automatically, so they get operator-UI access with no further action from
you.

This complements [`authentik-setup.md`](authentik-setup.md), which covers
the OAuth2/OIDC provider the operator API talks to. Do that setup first;
nothing here changes the operator app's `.env`.

## What you're building

One **enrollment flow** that runs these stages in order:

1. **Invitation** — refuses anyone without a valid invite token.
2. **Prompt** — user self-enters their details (no password field).
3. **User write** — creates the user and adds them to
   `telephone-booth-operators`.
4. **WebAuthn setup** — forces passkey registration.
5. **User login** — logs the new operator straight in.

The stages are independent objects you create first, then **bind** into the
flow in order. Build them in the sequence below.

## Prerequisites

- Authentik reachable over **HTTPS** on a stable domain. WebAuthn/passkeys
  are bound to the origin and will not work over plain HTTP (localhost is
  the only exception, for testing).
- The `telephone-booth-operators` group already exists (see
  [`authentik-setup.md`](authentik-setup.md) step 1).

## 1. Create the WebAuthn (passkey) stage

> _Flows & Stages → Stages → Create → **WebAuthn Authenticator Setup Stage**_

This is the stage type that _registers_ a passkey. (The similarly named
**Authenticator Validation Stage** _checks_ an existing passkey at login —
that's a different type, used in [step 8](#8-require-the-passkey-at-every-login-recommended).)

| Field                         | Value                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| Name                          | `booth-webauthn-setup`                                                                               |
| Authenticator type name       | `Passkey` (the label users see when enrolling)                                                       |
| User verification             | **Required** — forces biometric / PIN                                                                |
| Resident key requirement      | **Required** — makes it a true _passkey_ (discoverable credential)                                   |
| Authenticator Attachment      | **No preference** (phones, laptops, keys), or **Platform** to force built-in Face ID / Windows Hello |
| Hints                         | leave empty (advisory only)                                                                          |
| Maximum registration attempts | `0` (unlimited — don't lock people out mid-enrollment)                                               |
| Prevent duplicate devices     | **On**                                                                                               |
| Device type restrictions      | leave empty (allows all passkey-capable devices)                                                     |
| Configuration flow            | **leave empty**                                                                                      |

- **Resident key = Required** + **User verification = Required** is what
  turns a plain WebAuthn second-factor key into a passwordless **passkey**.
- **Configuration flow** only controls whether an already-logged-in user
  can later add/manage passkeys from their account settings. It is _not_
  needed for enrollment. Point it at `default-authenticator-webauthn-configuration`
  later if you want operators to self-manage backup passkeys.

Binding this stage as **not optional** ([step 6](#6-create-the-enrollment-flow-and-bind-the-stages))
is what forces the passkey.

## 2. Create the prompt fields, then the prompt stage

A Prompt **Stage** is a container; the input boxes are separate **Prompt
fields** you create first, then attach.

### 2a. Create three prompt fields

> _Flows & Stages → **Prompts** → Create_ (once per field)

Leave both _Interpret … as expression_ boxes unchecked, and leave
Placeholder / Initial value / Help text empty unless you want a hint.

| Name                    | Field Key  | Label       | Type         | Required | Order |
| ----------------------- | ---------- | ----------- | ------------ | -------- | ----- |
| `booth-prompt-username` | `username` | `Username`  | **Username** | on       | `100` |
| `booth-prompt-name`     | `name`     | `Full name` | **Text**     | on       | `200` |
| `booth-prompt-email`    | `email`    | `Email`     | **Email**    | on       | `300` |

- The Field Keys `username`, `name`, and `email` must be exactly these
  lowercase values — the User Write stage maps them onto the new user's core
  attributes. Only custom fields use the `attributes.foo` key form.
- **Do not** create a password field — the passkey is the only credential.
- Alternatively, reuse Authentik's built-in `default-enrollment-field-*`
  fields, but skip its `-password` and `-password-repeat` fields.

### 2b. Create the prompt stage

> _Flows & Stages → Stages → Create → **Prompt Stage**_

| Field               | Value                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| Name                | `booth-enroll-prompt`                                                                            |
| Fields              | select **only** the three `booth-prompt-*` fields above                                          |
| Validation Policies | leave the **Selected** column empty (the Available column just lists all policies in the system) |

## 3. Create the user-write stage

> _Flows & Stages → Stages → Create → **User Write Stage**_

| Field                    | Value                                                             |
| ------------------------ | ----------------------------------------------------------------- |
| Name                     | `booth-user-write`                                                |
| Create users as inactive | **Off** — new operators are active and can log in immediately     |
| User creation mode       | one of the **"Create users…"** options (not "Never create users") |
| Group                    | `telephone-booth-operators`                                       |
| User type                | **Internal**                                                      |
| User path template       | leave default                                                     |

Setting the group here auto-adds every self-enrolled user to the operators
group, matching `AUTHENTIK_ALLOWED_GROUPS` in
[`authentik-setup.md`](authentik-setup.md). Turn **Create users as inactive
On** only if you want a manual approval gate — but then you must activate
each user by hand, which breaks the fully self-serve goal.

## 4. Create the invitation stage

> _Flows & Stages → Stages → Create → **Invitation Stage**_

| Field                            | Value                                           |
| -------------------------------- | ----------------------------------------------- |
| Name                             | `booth-invitation`                              |
| Continue flow without invitation | **Off** — refuse anyone without an invite token |

This is what makes the flow invite-only: with the toggle off, opening the
flow without a valid `?itoken=` token stops it.

## 5. Create the User Login stage

You need a stage that attaches the newly created user to a session at the
end. Authentik ships **`default-source-enrollment-login`** (a User Login
Stage) you can reuse — no need to create one. If it's missing, create a
**User Login Stage** named `booth-user-login` with defaults.

## 6. Create the enrollment flow and bind the stages

> _Flows & Stages → Flows → Create_

| Field          | Value                                                          |
| -------------- | -------------------------------------------------------------- |
| Name           | `Booth operator enrollment`                                    |
| Title          | `Set up your operator passkey`                                 |
| Slug           | `booth-enrollment` (becomes part of the invite URL)            |
| Designation    | **Enrollment**                                                 |
| Authentication | **Require no authentication** (new users aren't logged in yet) |

Then open the flow **by clicking its name** in the Flows list (the pencil
only opens settings) → **Stage Bindings** tab → **Bind stage → Bind existing
stage**. Do this five times, setting **Order** each time:

| Order | Stage                                                     | Purpose                              |
| ----- | --------------------------------------------------------- | ------------------------------------ |
| 10    | `booth-invitation`                                        | validate the invite token            |
| 20    | `booth-enroll-prompt`                                     | collect user details                 |
| 30    | `booth-user-write`                                        | create user + add to operators group |
| 40    | `booth-webauthn-setup`                                    | **force** passkey registration       |
| 50    | `default-source-enrollment-login` (or `booth-user-login`) | log the new operator in              |

For each binding, keep the defaults:

- **Evaluate when flow is planned:** on
- **Evaluate when stage is run:** off
- **Invalid response behavior:** **RETRY** (a fumbled passkey attempt retries
  instead of losing progress)

Order sequences the stages, so the numbers matter more than the click order.
Don't mark the WebAuthn binding optional or users could skip the passkey.

## 7. Create an invitation and send the link

> _Directory → Invitations → Create_

| Field             | Value                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------- |
| Name              | a label for you, e.g. `invite-jane`                                                   |
| Expires           | a short window, e.g. 7 days                                                           |
| Flow              | `Booth operator enrollment` (`booth-enrollment`)                                      |
| Single use        | **On** for one person, **Off** to reuse for many                                      |
| Custom attributes | _optional_ JSON to pre-fill, e.g. `{"email": "jane@example.com", "name": "Jane Doe"}` |

Save, then open the invitation to copy the link (or construct it):

```text
https://<your-authentik-host>/if/flow/booth-enrollment/?itoken=<token>
```

Send that link. The recipient enters their details, is forced to register a
passkey, and lands logged in and already in `telephone-booth-operators`.
Everything after you click **Create** is self-serve.

### Single-use vs multi-use invitations

- **Single use On** — link dies after one successful enrollment. Best for
  one-per-person invites; you can pre-fill Custom attributes for a named
  individual, and revoke it by deleting the invitation.
- **Single use Off** — the same link works for multiple people until it
  **expires**. Convenient for onboarding a whole group at once. Delete the
  invitation to stop new enrollments (existing users are unaffected).

> **The invitation URL is a bearer credential — treat it like a password.**
> Anyone who obtains the link can consume it. Pre-filled Custom attributes
> only pre-populate the account form; they do **not** bind the invitation to
> a person's identity or verify who redeems it. Deliver the link over a
> trusted, private channel, keep the expiry short, and prefer **Single use
> On** when you need one link per person. Do not post it publicly.

## 8. Require the passkey at every login (recommended)

The enrollment flow only forces passkey **registration**, once. To require
the passkey on every sign-in, make sure your **authentication flow** uses
WebAuthn — for a passwordless setup, use an **Identification Stage** followed
by an **Authenticator Validation Stage** whose only allowed device class is
WebAuthn. Without this, a user could authenticate by other means.

## 9. Hiding other applications from operators

New operators land in the Authentik **user library**, where they may see
tiles for _other_ apps you run. Visibility and access work like this:

- An application shows as a **tile** only if it has a **Launch URL** and
  "Show in user interface" is on. Provider-only apps (e.g. a mobile app that
  just authenticates through Authentik) usually have no Launch URL, so they
  appear in the admin **Applications** list but never as a user tile —
  nothing to hide.
- An app with **no access bindings is visible/usable by everyone**. To scope
  it, open _Applications → Applications →_ the app → **Policy / Group / User
  Bindings** and bind the group that _should_ have it. This both hides the
  tile from non-members **and** refuses them at the authorize step (real
  access control, not just cosmetics).
- Bind the booth app itself to `telephone-booth-operators` (see
  [`authentik-setup.md`](authentik-setup.md) step 3) so operators see it and
  nothing else.

> Hiding a tile is not access control. If an app is a login provider you want
> restricted, add a group binding even when it has no tile — a client can
> still initiate login without a tile.

### Fixing a tile that points at `localhost`

Two different settings get confused here:

- **Wrong tile link** (navigation only): _Applications → Applications →_ the
  app → **Launch URL**. Change `http://localhost:…` to the real public URL,
  e.g. `https://komga.example.com`, and save. Hard-refresh the library if the
  old tile is cached.
- **Wrong login redirect** (sign-in bounces to localhost): that's the
  **provider's Redirect URIs**, a separate field on the OAuth2/OIDC provider
  — fix it there, not in the Launch URL.

## 10. Troubleshooting

| Symptom                               | Likely cause                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| "No available authenticators found"   | Browser/device doesn't support passkeys, or Authentik isn't served over HTTPS                     |
| Passkey prompt never appears          | WebAuthn binding marked optional, or ordered after the login stage                                |
| Prompt is missing fields / wrong keys | Prompt field keys aren't exactly `username` / `name` / `email`, or not attached to the stage      |
| Anyone can enroll without a link      | Invitation stage is missing from the flow, or its "continue without invitation" toggle is On      |
| New user can't reach the operator UI  | User-write group isn't `telephone-booth-operators`, or it differs from `AUTHENTIK_ALLOWED_GROUPS` |
| New user created but can't log in     | "Create users as inactive" is On — activate the user or turn it off                               |
| Invite link says expired / used       | Single-use invitation already consumed, or past its expiry — issue a new one                      |
| Operators see other apps' tiles       | Those apps have no group binding — bind each to its own group                                     |
| Tile opens `localhost`                | Fix the app's **Launch URL** (not the provider Redirect URIs)                                     |
