# Epic 01 - Typing Reliability And Fallback Delivery

Release target: `R0.2`
Priority: `P0`
Primary owner: Engineering
Supporting owners: Product, Design, TPM, QA
Status: Implemented

## Outcome

Users can trust Prompt Goblin to get text into the active app more consistently, even when direct typing is flaky.

## Scope

### Delivery slice 1 - Clipboard-safe fallback typing path

- define when fallback triggers automatically versus manually
- preserve line break behavior as closely as possible
- show clear overlay or status feedback when fallback is used

Acceptance criteria:

- when direct typing fails or the target app is known incompatible, the user can still insert the transcript without losing text
- fallback behavior does not silently replace clipboard contents without user-visible handling
- failure state and recovery path are understandable from UI feedback

### Delivery slice 2 - Target-app compatibility handling for typing modes

- identify apps or app classes where incremental typing is unreliable
- prefer all-at-once or fallback mode automatically where appropriate

Acceptance criteria:

- product does not keep retrying a known-bad typing path in the same session
- user can see when Prompt Goblin changed behavior for compatibility reasons

### Delivery slice 3 - Final delivery observability

- track session outcome categories: typed, fallback typed, canceled, failed

Acceptance criteria:

- local logs or counters distinguish transcription success from typing success

## Dependencies

- overlay and status messaging hooks
- target-app detection or failure detection strategy
- session outcome instrumentation

## Risks

- app-specific typing behavior may be inconsistent across Windows targets
- fallback handling can create trust issues if clipboard behavior is not explicit

## Definition Of Done

- a reliable fallback path exists for the primary Windows use case
- compatibility behavior is visible rather than silent
- session outcomes can be reviewed during support and release validation
