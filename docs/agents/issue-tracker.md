# Issue tracker: Linear

Issues and specs for this repo live in **Linear**, not GitHub Issues. GitHub is used for pull requests only.

Use the **Linear MCP tools** (`mcp__linear__*`) for all operations. There is no CLI step.

## Workspace shape

- **Team**: `OrderSail` — the only team in the workspace.
- **Issue identifiers**: `OS-###` (e.g. `OS-494`). Commits and branches reference these directly:
  `feat(merchant-api): ... (OS-494)`, branch `noelvegajr94/os-494-<slug>`.
- **Projects**: work is grouped into Linear projects (e.g. "Payments & billing", "Storefront Builder",
  "Security & compliance"). List them with `list_projects`.
- **Milestones**: projects are further divided into milestones (M1, M2, …). List them with
  `list_milestones`. A new issue almost always belongs to both a project and a milestone.

## Conventions

- **Create an issue**: `save_issue` with `team: "OrderSail"`, a `title`, and a Markdown `description`.
  Set `project` and `milestone` when the work belongs to an existing tranche. Omit `id` when creating.
- **Read an issue**: `get_issue` with the identifier (`OS-494`). Use `list_comments` for the discussion.
- **List issues**: `list_issues` filtered by `team`, `project`, `milestone`, `state`, or `label`. Pass
  `fields` to select what you need (e.g. `["id","title","description","status","labels","project"]`).
- **Update an issue**: `save_issue` with `id: "OS-494"`. Prefer `patch` for surgical description edits
  over resending the whole body.
- **Comment**: `save_comment` with the issue identifier.
- **Apply / remove labels**: `save_issue` with `addLabels` / `removeLabels` (incremental).
  Do **not** use `labels`, which replaces the entire set.
- **Close**: `save_issue` with `state: "Done"` (or `"Canceled"` for work that won't be actioned).

## When a skill says "publish to the issue tracker"

Create a Linear issue on team `OrderSail`, attached to the relevant project and milestone.

Issues here are deliberately **small and single-PR**: prefer many narrow issues over few broad ones,
and don't cap the count to hit a round number.

## When a skill says "fetch the relevant ticket"

`get_issue` with the `OS-###` identifier, plus `list_comments` for the discussion. If you only have a
branch name, the identifier is in it (`noelvegajr94/os-494-...` → `OS-494`).

## Phase 0: descriptions before code

Every milestone starts by writing or refreshing the descriptions of all its issues as a reviewable
pass, before any implementation begins. Treat that as part of the tracker workflow, not an optional extra.

## Pull requests as a request surface

**PRs as a request surface: no.** _(Set to `yes` if this repo should treat external PRs as feature
requests; `/triage` reads this flag.)_

## Wayfinding operations

Used by `/wayfinder`. Linear models the map natively, so no fallbacks are needed.

- **Map**: a Linear issue on team `OrderSail` holding the Notes / Decisions-so-far / Fog body, labelled
  `wayfinder:map`.
- **Child ticket**: an issue created with `parentId` set to the map's identifier — a real Linear
  sub-issue. Label it `wayfinder:<type>` (`research` / `prototype` / `grilling` / `task`). Once claimed,
  set `assignee`.
- **Blocking**: native Linear issue relations. `save_issue` with `blockedBy: ["OS-123"]` on the child
  (or `blocks` on the blocker). Remove with `removeBlockedBy`. A ticket is unblocked when every blocker
  reaches a completed or canceled state.
- **Frontier query**: `list_issues` with `parentId: "<map>"` and an incomplete `state`, then drop any
  with an unresolved blocker or an existing `assignee`. First in map order wins.
- **Claim**: `save_issue` with `assignee: "me"` — the session's first write.
- **Resolve**: `save_comment` with the answer, then `save_issue` with `state: "Done"`, then append a
  context pointer to the map's Decisions-so-far.
