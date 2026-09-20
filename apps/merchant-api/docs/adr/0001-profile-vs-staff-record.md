# A User row has two aspects: Profile and Staff record

A `users` row is read and written by two different audiences with different
rights: the person themselves (name, phone, credentials) and the organization
(roles, status, invite lifecycle, deactivation). We model these as two distinct
aspects with separate endpoints and separate pages — **Profile** at `/app/me`,
backed by `/auth/me/*` and gated only on being authenticated, and **Staff
record** at `/app/users/$id`, backed by `/users/*` and gated on `users:read` /
`users:write` — rather than one surface that carries permission exceptions for
the self case.

## Considered options

**One endpoint with a self-branch** — what the code did before this decision.
`PATCH /users/:id` carried an explicit exception ("a user may always edit their
own name/phone"), and `routes/app/users/$id.tsx` carried the matching exception
in `beforeLoad`. The two drifted: the route admitted a permissionless user to
their own row, but `GET /users/:id` had no matching exception and refused them.
A permission gate with a hole in it invites exactly this — the hole has to be
punched in every handler and every route, and the one that gets missed is a
silent 403 rather than a build error.

**Reuse the admin page for self.** Tempting, because the Staff record view
(`staff-record.view.tsx`; `user-detail.view.tsx` at the time) already branched
on `isSelf`. Rejected because the page is admin-shaped: a
back-link to a staff list the viewer can't read, a breadcrumb reading *Users ›
Their Own Name*, and roles they can't change. It also has nowhere coherent to
put credentials — a password card belongs next to passkeys, not next to a
"Deactivate" button aimed at someone else.

## Consequences

- `PATCH /users/:id` loses its self-branch and becomes a plain `users:write`
  endpoint. This breaks self-callers of that endpoint; acceptable pre-launch.
- Personal concerns that arrive later — notifications, saved views, preferences
  — have an obvious home (`/app/me/*`, `/auth/me/*`) and need no new permission
  keys, since an endpoint scoped to `user.sub` cannot leak across users.
- The forced-MFA-enrollment redirect target moved from `/app/settings/security`
  to `/app/me/security`. It's the one path where a mistake locks invited staff
  out of the app.
- This ADR lives under `merchant-api` because the aspect split is an identity-context
  model decision, but it constrains `merchant-web`'s routes too.
