# Changelog

All notable Provara changes are tracked here.

## 0.2.0 - 2026-05-01

### Added

- Prompt Injection Firewall preset for built-in instruction override, system prompt extraction, role takeover, and delimiter-injection signatures.
- Source-aware firewall scan API: `POST /v1/admin/guardrails/scan` supports `user_input`, `retrieved_context`, `tool_output`, and `model_output`.
- Optional semantic and hybrid prompt-injection scan modes using the configured judge model.
- Tool-call alignment guardrail for undeclared tools, invalid tool-call JSON, suspicious argument injection, and data-exfiltration patterns.
- Model refusal fallback for provider responses that end in `content_filter`.
- Persisted `firewall_events` for scan and tool-call alignment activity.
- Tenant firewall settings for default scan mode, tool-call alignment mode, and streaming enforcement.
- Guardrails dashboard sections for Prompt Injection Firewall settings and recent firewall events.
- OpenAPI coverage for firewall scan, settings, and event endpoints.
- Tool-calling support across OpenAI-compatible, Anthropic, and Google adapters.

### Changed

- Guardrails documentation now treats Prompt Injection Firewalling as a first-class guardrails capability.
- The Guardrails dashboard custom-rule creation button now lives beside the Custom Rules table.
- Streaming tool-call responses can buffer tool-call deltas until alignment checks pass.
- Semantic and hybrid firewall scan modes are gated behind Intelligence access on Cloud while deterministic signature scans remain the default path.

### Fixed

- Provider fallback now retries on model refusals instead of only provider errors.
- Tool-capability routing avoids sending tool requests to models that do not support tools.
- Low-score routing diagnostics and challenger probes are easier to surface in the quality workflow.

### Upgrade Notes

- Run database migrations through `0044_firewall_settings`.
- New tables:
  - `firewall_events`
  - `firewall_settings`
- Existing tenants keep the safe default firewall settings:
  - `defaultScanMode: "signature"`
  - `toolCallAlignment: "block"`
  - `streamingEnforcement: true`
- The public OpenAPI copy in `apps/web/public/openapi.yaml` is generated from `packages/gateway/openapi.yaml` during web build.

