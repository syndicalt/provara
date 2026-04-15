// Built-in PII detection patterns
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
];
