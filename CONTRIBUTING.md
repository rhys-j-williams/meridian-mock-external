# Contributing to External system mocks

Owning team: @meridian/platform-engineering. Ask in `#platform-engineering` on the internal chat platform before starting anything that
crosses a team boundary.

## Branches

| Branch | Purpose |
|---|---|
| `main` | What is in production. Tagged per release train. |
| `develop` | Integration. Everything merges here first. |
| `release/2026.09` | The current train, cut from `develop` at code freeze. |

Feature branches are `feature/PLAT-1234-short-description`. Also permitted: `bugfix/`, `hotfix/`,
`spike/`, `chore/`. The pre-commit hook rejects anything else.

## Commits

`PLAT-1234 imperative summary`, 72 characters or fewer, with an optional body explaining why. The
ticket key is mandatory; the commit hook rejects commits without one. Reference the release train
in merge commits, for example `Merge release/2026.08 into main for train 2026.08.2`.

## Release trains

Fortnightly, cut on a Tuesday, deployed the following Thursday evening. Code freeze is 17:00 New
York time on the Monday before the cut. Quarter end freezes apply for the last two weeks of March,
June, September and December; only Sev 1 and Sev 2 hotfixes ship in a freeze, and each needs a
change advisory board reference. The calendar is in `platform-tooling/governance/RELEASE_CALENDAR.md`.

## Pull requests

Two approvals, one of which must come from the owning team. Security sensitive paths listed in
CODEOWNERS additionally require @meridian/gis-appsec. Fill in every field of the pull request
template; the change advisory board reference may be `N/A` outside a freeze, but the rollback plan
may not.

## Standing constraints

- Dependency versions are exact. No caret or tilde ranges. Lockfiles are committed.
- Only the internal registry is used. See DEPENDENCY_POLICY.md in platform-tooling.
- Framework and runtime upgrades are platform-level changes and are planned through the
  architecture forum, not raised opportunistically inside a feature pull request.
