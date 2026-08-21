---
name: codexless-pipeline
description: Use the Codexless federation, Box Queue/Monitor, Codex, OpenAI API, and Codeman integration pipeline safely.
---

# Codexless Pipeline Consumer

Use this skill when Codeman receives or displays work dispatched by Codexless.

## Event Contract

External job events arrive through the authenticated integration webhook:

```text
POST /api/v1/integrations/<id>/events
X-Codeman-Timestamp: <unix seconds>
X-Codeman-Signature: v1=<HMAC-SHA256(timestamp.raw-body)>
```

Accepted job event types are `job.updated`, `job.completed`, and `job.failed`.
The event subject is an opaque `boxm://job_...` reference. Do not treat it as a
filesystem path, process identifier, or permission token.

The integration secret is returned only when an administrator creates or rotates
an integration. Never log it, commit it, put it in an event payload, or expose it
through an SSE event.

## Durable State

The webhook acknowledges an event only after it is durably accepted. Event IDs
are idempotent per integration. Sequence numbers and timestamps prevent stale
events from replacing newer job projections.

Use these recovery endpoints after SSE reconnects:

- `GET /api/v1/integrations/jobs`
- `GET /api/v1/integrations/events?limit=100`

The native SSE projections are:

- `integration:jobUpdated`
- `integration:jobCompleted`
- `integration:jobFailed`

Callers cannot choose arbitrary SSE event names.

## UI Rules

- Render provider-neutral status, provider, usage class, task reference, and bounded artifact counts.
- Never render prompts, API keys, local filesystem roots, raw logs, or cookies.
- Hydrate from the recovery endpoint on page load and reconnect.
- Apply SSE updates idempotently by the opaque job subject.
- Keep external jobs separate from Codeman-native sessions and tasks unless a future explicit correlation contract is added.

## Failure Handling

- `401` means the timestamp or HMAC is invalid; do not retry blindly.
- `403` means the integration is not allowlisted for that event type.
- `429`, network errors, and `5xx` are transient sender-side conditions.
- A duplicate `200` is success and must not produce a second UI side effect.
- A stale accepted event updates history but must not regress the current job card.
