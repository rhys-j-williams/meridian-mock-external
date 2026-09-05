## Summary

<!-- What changes and why. One paragraph. -->

## Jira

Key: PLAT-
Epic:

## Change advisory board

CAB reference: <!-- CHG number, or N/A outside a freeze window -->
Release train: 2026.09.x

## Risk

Rating: <!-- low | medium | high -->
Blast radius: <!-- which surfaces and which customer journeys -->
Feature flag: <!-- Semaphore flag name, or none -->

## Rollback plan

<!-- Exact steps. "Revert the commit" is only acceptable when nothing has migrated. -->

## Verification

- [ ] Unit tests pass locally and in the pipeline
- [ ] Lint passes
- [ ] Ran against the local mock estate (`mock-external/estate-up.sh`)
- [ ] Accessibility check completed for any changed screen (keyboard path, focus order, announcer)
- [ ] No new high severity Checkmarx or Xray findings
- [ ] Screenshots attached for visual changes

## Reviewers

<!-- CODEOWNERS will request the owning team. Add @meridian/gis-appsec for security sensitive paths. -->
