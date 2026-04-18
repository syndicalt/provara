# Operator runbook: `PROVARA_MASTER_KEY` rotation

`PROVARA_MASTER_KEY` encrypts one thing: the per-tenant provider API keys stored via `/dashboard/api-keys` (table: `api_keys`, AES-256-GCM via `packages/gateway/src/crypto/index.ts`). Env-var-driven providers (`OPENAI_API_KEY` on the server, etc.) never touch the master key.

## When to rotate

- **Compromise** — the key leaked to logs, a repo, a shared environment, or a departed operator had access.
- **Scheduled hygiene** — suggested once per year.
- **Employee off-boarding** — if the departing person had prod env access, treat as a compromise.

No rotation required for:

- Adding / removing a tenant's provider key (the key is encrypted with the current master; master doesn't change)
- Rolling a deployment
- Turso DB restore

## Rotate — happy path

1. **Generate a new key.**
   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   Save the output into your secrets manager as `PROVARA_MASTER_KEY_NEW`. Do **not** commit or paste into Slack.

2. **Dry-run against production.** Proves every row decrypts with the old key before you touch anything.
   ```sh
   DATABASE_URL="<prod libSQL URL>" \
   DATABASE_AUTH_TOKEN="<prod token>" \
     npm run key:rotate -w packages/gateway -- \
       --old "$PROVARA_MASTER_KEY_OLD" \
       --new "$PROVARA_MASTER_KEY_NEW" \
       --dry-run
   ```
   Expected output: `[rotate] DRY RUN — scanned N row(s). Every row decrypts cleanly with the --old key.`

3. **Perform the rotation.** Same command without `--dry-run`.
   ```sh
   DATABASE_URL="<prod libSQL URL>" \
   DATABASE_AUTH_TOKEN="<prod token>" \
     npm run key:rotate -w packages/gateway -- \
       --old "$PROVARA_MASTER_KEY_OLD" \
       --new "$PROVARA_MASTER_KEY_NEW"
   ```
   Expected output: `[rotate] rotated N of N row(s).`

4. **Swap the deployment env var.** On Railway, update `PROVARA_MASTER_KEY` to the new value and trigger a redeploy. The gateway reads `process.env.PROVARA_MASTER_KEY` once per encrypt/decrypt call, so the new value takes effect as soon as the new process starts serving.

5. **Verify.** Load `/dashboard/api-keys` on a tenant that has at least one key stored (anyone from the `api_keys` table). The key should decrypt and display with its masked prefix (e.g. `••••••••abcd`). Sending a chat completion that routes through a DB-stored provider key is the strongest end-to-end check.

6. **Retire the old key.** Remove `PROVARA_MASTER_KEY_OLD` from your secrets manager once verification passes.

## Failure modes

### "Decrypt failed for api_keys.id=... — the --old key does not match"

Something in the table was encrypted with a different key than the one you passed. Causes:

- The `--old` value is wrong (most common — mistyped or copy-paste truncation).
- Someone previously rotated some rows but not all and you don't know about it.
- A row was written directly to the DB without going through the gateway encrypt path.

The rotation **aborts before writing anything**, so the DB is unchanged. Fix the input or investigate the foreign row (delete it if it's corrupt / unrecoverable), then re-run.

### Network blip mid-rotation

Phase 1 (decrypt-all-into-memory) succeeds, phase 2 (write-back) fails partway through. The table is now half-old / half-new.

**Recovery:** rerun with the **same** `--old` and `--new`. Rows already rotated will no longer decrypt with `--old`, so the rerun will fail immediately with a clear error pointing at the first rotated row. At that point:

- If you can tell which rows were rotated (from the CLI output of the interrupted run), re-run the CLI with `--old "$NEW"` and `--new "$NEW"` is rejected (same-key guard), so you'll need to surgically handle the split: write a one-off variant of the CLI that takes a comma-separated list of ids to skip. This has never happened in practice at our scale.
- Easier path in practice: restore the `api_keys` table from the most recent snapshot (Turso point-in-time recovery, or the operator-taken dump below) and retry rotation cleanly.

### Wrong env var after swap

Gateway logs `PROVARA_MASTER_KEY is required for API key encryption` on every chat completion. The env var was unset entirely — restore it and restart.

Gateway logs decryption errors on dashboard loads — env var was set to the wrong value. Restore the correct value (whichever one the `api_keys` table is currently encrypted under) and restart.

## Pre-rotation snapshot (recommended)

Before step 3, dump the `api_keys` table so you have an undisputed restore target:

```sh
turso db shell <db-name> "SELECT * FROM api_keys" > ./snapshots/api_keys_pre_rotation_$(date +%Y%m%d_%H%M).tsv
```

Keep the dump in a secrets-managed location (it contains ciphertext, which is only decryptable with the old key). Retain for 30 days post-rotation.

## Out of scope (at current scale)

- Transactional single-statement rotation — would require dropping libSQL's `:memory:` test database; the current two-phase-with-decrypt-gate handles the real failure mode (wrong `--old` key) and the network-blip-mid-rotation case is recoverable via snapshot.
- Dual-key read window — would let the gateway read with either key during rotation, removing the redeploy coupling. Overkill for low-hundreds-of-rows scale.
- Temp-column pattern — dual-write into `encrypted_value_v2` / `iv_v2` / `auth_tag_v2`, swap column names in a follow-up migration. Worth revisiting if row count reaches low thousands.
