import { redirect } from "next/navigation";

/**
 * Redirect to the gateway's `/demo` endpoint. The actual session cookie
 * has to be set by the gateway (that's where the sessions table lives
 * and what owns the auth domain), so this page exists purely so that
 * `www.provara.xyz/demo` resolves when typed or shared instead of
 * 404ing. The hero CTA on `/` links directly to the gateway URL for a
 * single-hop; this is the fallback for everything else.
 *
 * `NEXT_PUBLIC_GATEWAY_URL` is the same env var all other gateway
 * fetches use — on Cloud it's `https://gateway.provara.xyz`, on
 * self-host it can be relative to the same origin or a different one.
 */
export default function DemoRedirect() {
  const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL || "";
  redirect(`${gateway}/demo`);
}
