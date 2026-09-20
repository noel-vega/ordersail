# Identity

Who can sign in, who they are, and what they're allowed to do: accounts, users,
credentials, roles and permissions.

## Language

**Account**:
A merchant tenant. Every other resource in the platform is scoped to one.
_Avoid_: Organization, workspace, team, merchant. Never use "account" for a
person's login — that's a User.

**User**:
A person who signs in to the merchant dashboard, belonging to exactly one
Account.
_Avoid_: Member, employee, admin. A Customer is a different thing entirely —
they shop on a storefront and never sign in here.

**Profile**:
The self-editable attributes of a User — name and phone — as seen and changed
by that User themselves, at `/app/me`. Ungated by construction: it can only
ever touch the caller's own row.
_Avoid_: My Account, personal account, settings.

**Staff record**:
The same User row as the org sees it — roles, status, invite lifecycle,
deactivation — at `/app/users/$id`, behind `users:read`. The administrative
aspect, as distinct from the Profile.
_Avoid_: User detail, user admin page.

**Factor**:
A sign-in credential that isn't a password: a passkey or a confirmed
authenticator app. Either one satisfies a factor requirement; the two are
deliberately interchangeable.
_Avoid_: 2FA, MFA (as a countable noun), second factor — a passkey can be the
*only* factor, not a second one.

**Session**:
One continuous sign-in by a User on one browser. It begins when they prove who
they are and ends on sign-out, revocation, or expiry; a User can hold many at
once. A password accepted but a Factor still owed is not yet a Session.
_Avoid_: Login, token, family (that is how a Session is stored, not what it
is).

**Emailed link**:
A single-use, expiring link sent to a User's inbox; following it proves control
of that inbox and nothing more. Three kinds — Invite, password reset, email
verification — and issuing a new one replaces the last of its kind.
_Avoid_: Magic link (it never signs anyone in by itself), token (that is how a
link is recognised, not what it is), OTP.

**Invite**:
The Emailed link that lets a person join an Account as a User by choosing their
password. Until it is followed, their Staff record is pending.
_Avoid_: Invitation token, signup link.

**Permission**:
One key from the fixed catalog in `packages/db/src/permissions-catalog.ts`,
granted to a User through a Role. New keys ship as a code change, never through
the API.
_Avoid_: Scope, capability, grant.

**Role**:
A named, per-Account bundle of Permissions. `Owner` is seeded at signup and is
the only role the platform defines; every other role is authored by the
merchant.
