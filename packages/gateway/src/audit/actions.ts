/**
 * Canonical action vocabulary for the audit log (#210). Centralized so
 * the call-sites (T3) and the dashboard filter (T6) can't drift —
 * adding a new action means editing this file and nothing else.
 *
 * Naming: dot-delimited `<area>.<object>.<verb>`. Past tense for
 * completed events (`user.removed`) because the log is a history.
 *
 * Keep actions granular enough to be meaningful on a compliance review
 * without becoming noise: `auth.login.success` per successful login is
 * useful; `request.completed` per chat-completion is not (that's what
 * the `requests` table is for).
 */

// Auth events
export const AUDIT_AUTH_LOGIN_SUCCESS = "auth.login.success";
export const AUDIT_AUTH_LOGIN_FAILED = "auth.login.failed";
export const AUDIT_AUTH_SESSION_REVOKED = "auth.session.revoked";
export const AUDIT_AUTH_SSO_CONFIG_UPDATED = "auth.sso_config.updated";

// User / team events
export const AUDIT_USER_INVITED = "user.invited";
export const AUDIT_USER_JOINED = "user.joined";
export const AUDIT_USER_REMOVED = "user.removed";
export const AUDIT_USER_ROLE_CHANGED = "user.role_changed";

// API-access-surface events
export const AUDIT_API_KEY_CREATED = "api_key.created";
export const AUDIT_API_KEY_REVOKED = "api_key.revoked";
export const AUDIT_TOKEN_CREATED = "token.created";
export const AUDIT_TOKEN_REVOKED = "token.revoked";
export const AUDIT_TOKEN_ROTATED = "token.rotated";

// Prompt management (#35)
export const AUDIT_PROMPT_TEMPLATE_CREATED = "prompt.template.created";
export const AUDIT_PROMPT_TEMPLATE_UPDATED = "prompt.template.updated";
export const AUDIT_PROMPT_TEMPLATE_DELETED = "prompt.template.deleted";

// Alerting (#34)
export const AUDIT_ALERT_RULE_CREATED = "alert.rule.created";
export const AUDIT_ALERT_RULE_UPDATED = "alert.rule.updated";
export const AUDIT_ALERT_RULE_DELETED = "alert.rule.deleted";

// Billing events (emitted from Stripe webhooks + /checkout-session)
export const AUDIT_BILLING_SUBSCRIPTION_CREATED = "billing.subscription.created";
export const AUDIT_BILLING_SUBSCRIPTION_UPDATED = "billing.subscription.updated";
export const AUDIT_BILLING_SUBSCRIPTION_CANCELED = "billing.subscription.canceled";
export const AUDIT_BILLING_CHECKOUT_STARTED = "billing.checkout.started";

// Abuse / security signals (#192). Emitted only when the blocked caller
// has a resolvable tenant (bearer token or session); unauthenticated
// rate-limit hits log to stdout and stay out of audit_logs to keep the
// compliance view uncluttered.
export const AUDIT_RATE_LIMIT_EXCEEDED = "rate_limit.exceeded";

/**
 * Convenience union of every canonical action. Runtime validators can
 * use this via `Object.values(AUDIT_ACTIONS).includes(x)`.
 */
export const AUDIT_ACTIONS = {
  AUDIT_AUTH_LOGIN_SUCCESS,
  AUDIT_AUTH_LOGIN_FAILED,
  AUDIT_AUTH_SESSION_REVOKED,
  AUDIT_AUTH_SSO_CONFIG_UPDATED,
  AUDIT_USER_INVITED,
  AUDIT_USER_JOINED,
  AUDIT_USER_REMOVED,
  AUDIT_USER_ROLE_CHANGED,
  AUDIT_API_KEY_CREATED,
  AUDIT_API_KEY_REVOKED,
  AUDIT_TOKEN_CREATED,
  AUDIT_TOKEN_REVOKED,
  AUDIT_TOKEN_ROTATED,
  AUDIT_PROMPT_TEMPLATE_CREATED,
  AUDIT_PROMPT_TEMPLATE_UPDATED,
  AUDIT_PROMPT_TEMPLATE_DELETED,
  AUDIT_ALERT_RULE_CREATED,
  AUDIT_ALERT_RULE_UPDATED,
  AUDIT_ALERT_RULE_DELETED,
  AUDIT_BILLING_SUBSCRIPTION_CREATED,
  AUDIT_BILLING_SUBSCRIPTION_UPDATED,
  AUDIT_BILLING_SUBSCRIPTION_CANCELED,
  AUDIT_BILLING_CHECKOUT_STARTED,
  AUDIT_RATE_LIMIT_EXCEEDED,
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
