// Built-in PII detection patterns + jailbreak/prompt-injection signatures.
// All patterns compile with `gi` flags in engine.ts, so case-insensitivity is
// free — patterns stay readable.
export const BUILTIN_RULES = [
  {
    name: "SSN (US Social Security Number)",
    type: "pii" as const,
    pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b",
    target: "both" as const,
    action: "redact" as const,
  },
  {
    name: "Credit Card Number",
    type: "pii" as const,
    pattern: "\\b(?:\\d{4}[- ]?){3}\\d{4}\\b",
    target: "both" as const,
    action: "redact" as const,
  },
  {
    name: "Email Address",
    type: "pii" as const,
    pattern: "\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b",
    target: "both" as const,
    action: "flag" as const,
  },
  {
    name: "Phone Number (US)",
    type: "pii" as const,
    pattern: "\\b(?:\\+?1[- ]?)?\\(?\\d{3}\\)?[- ]?\\d{3}[- ]?\\d{4}\\b",
    target: "both" as const,
    action: "flag" as const,
  },
  {
    name: "IP Address",
    type: "pii" as const,
    pattern: "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b",
    target: "both" as const,
    action: "flag" as const,
  },
  {
    name: "AWS Access Key",
    type: "content" as const,
    pattern: "\\bAKIA[0-9A-Z]{16}\\b",
    target: "input" as const,
    action: "block" as const,
  },
  {
    name: "Generic API Key/Secret",
    type: "content" as const,
    pattern: "(?i)(?:api[_-]?key|api[_-]?secret|access[_-]?token|secret[_-]?key)\\s*[:=]\\s*['\"]?[A-Za-z0-9_\\-]{20,}",
    target: "input" as const,
    action: "block" as const,
  },

  // Jailbreak / prompt-injection detection (#265). Disabled by default;
  // tenants opt in from the dashboard once they understand the false-positive
  // tradeoff. Input-side only — output-side detection is a separate problem.
  {
    name: "Jailbreak — instruction override",
    type: "jailbreak" as const,
    pattern:
      "\\b(?:ignore\\s+(?:all\\s+|your\\s+|previous\\s+|prior\\s+|earlier\\s+|the\\s+)*(?:instructions?|prompts?|rules?|system\\s+prompts?)|forget\\s+(?:everything|all)\\s+(?:above|before)|disregard\\s+(?:the\\s+|your\\s+|previous\\s+)?(?:instructions?|rules?))\\b",
    target: "input" as const,
    action: "block" as const,
  },
  {
    name: "Jailbreak — system prompt extraction",
    type: "jailbreak" as const,
    pattern:
      "\\b(?:reveal|show|print|output|repeat|display)\\s+(?:me\\s+)?(?:your|the)\\s+(?:system\\s+prompt|initial\\s+prompt|instructions?|rules?|guidelines?|original\\s+prompt)\\b",
    target: "input" as const,
    action: "block" as const,
  },
  {
    name: "Jailbreak — role reversal / mode switch",
    type: "jailbreak" as const,
    pattern:
      "\\b(?:you\\s+are\\s+now\\s+(?:DAN|DUDE|STAN|Do\\s+Anything\\s+Now|Developer\\s+Mode|Admin\\s+Mode|Jailbroken)|pretend\\s+(?:you\\s+are|to\\s+be)\\s+(?:an?\\s+|the\\s+)?(?:unrestricted|uncensored|unfiltered|jailbroken|unlocked)|enable\\s+(?:developer|debug|admin|god|sudo)\\s+mode)\\b",
    target: "input" as const,
    action: "block" as const,
  },
  {
    name: "Jailbreak — delimiter injection",
    type: "jailbreak" as const,
    pattern:
      "(?:#{2,}\\s*(?:new\\s+instructions?|end\\s+of\\s+system|override|system\\s+prompt)|</(?:system|instructions?)>|\\[\\s*SYSTEM\\s*\\]|\\n\\s*SYSTEM\\s*:)",
    target: "input" as const,
    action: "block" as const,
  },
];
