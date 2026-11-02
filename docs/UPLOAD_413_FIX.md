# Production 413 upload fix

## Root cause and architecture

The supplied production Network evidence identifies Vercel's `FUNCTION_PAYLOAD_TOO_LARGE` response before application processing. The previous browser request posted the entire PDF as multipart data to `/api/documents`; that handler buffered it and uploaded it to Storage. A product limit of 10 MiB exceeded the Vercel request-body limit.

The browser now posts small JSON metadata, receives a server-generated private object path and a path-specific signed upload token, and uploads directly to Supabase's Storage hostname using TUS. Completion verifies persisted bucket, exact path, owner folder, MIME type and size against immutable server-managed document metadata. Only then does the existing `/api/process-document` extraction run, followed by the unchanged analysis endpoint. Existing extraction still reads the private PDF from Storage; the browser never sends PDF bytes to an application function.

The TUS client uses 6 MiB chunks, authenticated session credentials refreshed before requests, an `x-signature` scoped to the server-selected object, and no overwrite. No service-role key reaches browser code. Implementation follows the [Supabase resumable upload documentation](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).

## Live configuration and security

- Existing `rfps` bucket: private, `file_size_limit = 10485760`, allowed MIME type `application/pdf`. No bucket settings changed.
- Live config comparison reports no difference from the repository's global Storage limit of `50MiB`. No global settings changed.
- Existing Storage policies inspected live: authenticated INSERT, SELECT and DELETE restricted to `rfps/<auth.uid()>/...`; no UPDATE/overwrite policy. No Storage RLS changes.
- Existing document owner SELECT/INSERT/UPDATE policies remain. A new trigger requires document creation through the server and prevents authenticated clients from changing document identity, verification or extraction leases. Unverified records cannot advance status through a client update.
- New cleanup-path table has RLS enabled, no client policies, and privileges only for the service role. Its trigger function lives in `private` with PUBLIC execution revoked.
- Supabase security advisors before and after migration returned the same three existing warnings (public `rls_auto_enable()` execution for anon/authenticated and leaked-password protection disabled); no new findings.
- Migration `20261102194718` applied and recorded in migration history.
- Production's existing `INNGEST_DEV` setting initially selected development mode and prevented cloud sync. With explicit user approval, production now uses `false`; the shared variable was split so Preview retains development mode (`true`). The clean checkout was redeployed and Inngest returned `Successfully registered`. Cloud's API confirms the existing analysis trigger and new hourly cleanup cron are registered. No analysis implementation or quota logic changed.

## Lifecycle and recovery

No document status values were added or removed. Prepared records use existing `UPLOADED` with NULL `upload_verified_at`; old records retain their completed-upload meaning. The library derives an `UPLOAD_PENDING` display label without changing persisted status values.

The browser persists a request UUID under the user and file-content hash before authorization. Authorization retries reuse its document and server-selected path. Failed transfers retain the record for recovery, and TUS persists offsets for the same user/document/file. After refresh, selecting the same PDF resumes the transfer. If Storage already completed, completion succeeds without re-uploading. A lost completion response displays failure until the server confirms recovery. Duplicate completion calls do not start extraction or reset document status.

Extraction uses an atomic database lease. One request can claim it; overlapping requests receive 409. A terminated function's lease expires after 90 seconds, beyond the existing 60-second function duration. Completed extraction returns existing page count; page upserts retain their original unique document/page key. Failed extraction and failed analysis dispatch can be retried using the same uploaded document. Analysis dispatch and entitlement decisions remain in the existing pipeline.

Authorization can be renewed for 24 hours after creation, and completion recovered for 48 hours. An hourly Inngest function removes unverified records older than 72 hours, deleting Storage first and preserving database records on any Storage failure. Deleted documents leave a private cleanup-path tombstone for 72 hours so an outstanding signed token/TUS upload cannot leave a permanent orphan. This grace period exceeds signed-token and resumable-resource lifetimes. The existing user deletion endpoint and its storage-first hard gate are unchanged.

## Validation

- Production build and TypeScript pass.
- Targeted ESLint and `git diff --check` pass.
- Browser regression uses disposable Supabase accounts and the actual `6565dbb36c16dTenderdoc144.pdf`: 6,774,486 bytes (6.46 MiB), 283 extracted pages.
- Covers authorization idempotency, unverified extraction rejection, foreign completion rejection, forged-verification rejection, wrong-size-object rejection, existing deletion, client rejection over 10 MiB, interruption/refresh/resume, lost completion response, duplicate completion, private object isolation, library visibility, exclusive extraction leases, stale lease recovery, and retry after simulated dispatch failure.
- Run locally: `node --env-file=.env.local tests/document-upload.cjs` against a built app at `http://127.0.0.1:3000`.
- Production: set `UPLOAD_TEST_BASE_URL=https://www.rfpground.com` and add `--analysis` to exercise the real analysis pipeline and quota consumption. Test cleanup removes Storage objects before deleting disposable users.
- Production cleanup regression: `node --env-file=.env.local tests/upload-cleanup.cjs` invokes the registered cron with disposable stale-upload and late-orphan fixtures, then confirms both objects and corresponding records are removed. Passed against Inngest Cloud.

## Production result

**VERIFIED on 3 November 2026 (Asia/Kolkata)** against `https://www.rfpground.com`.

- Clean-checkout production deployment: `dpl_Ffx1BVLUqrAUBRbgtoTkVv5PSfgM`, deployed source commit `fc71734` on `fix/direct-storage-uploads`. Vercel URL: `https://rfpground-98jjcag9i-chiranjeevi005s-projects.vercel.app`.
- Actual valid tender PDF: `6565dbb36c16dTenderdoc144.pdf`, **6,774,486 bytes**, greater than Vercel's request limit and below the 10 MiB product limit.
- Browser TUS POST/PATCH requests went directly to `dcicrwkyxqacaronwato.storage.supabase.co`. `/api/documents` received **135-byte JSON metadata**, never a PDF body. No `FUNCTION_PAYLOAD_TOO_LARGE` occurred.
- Deliberately interrupted the final upload chunk, refreshed, reselected the same file and resumed. Deliberately lost a successful server completion response, then recovered by retrying. Storage persisted exactly one PDF and the server verified it.
- Existing library contained one document; **283 pages** extracted. Duplicate completion requests succeeded without duplicate documents. Cross-user completion/download failed. Oversized PDF was rejected in the browser before any upload request.
- Final production browser test exited **0**. Analysis run `86c0836e-6de2-43ad-a13b-74cf63e349af` completed for test document `25ffadb2-0e18-4b1d-aff7-51682754b46a`. Exactly **one** entitlement ledger entry reached **CONSUMED**. Existing workspace returned HTTP 200 and displayed **Analysis Complete**, 283 pages and 86 findings.
- Workspace screenshot: local `scratch/upload-production-workspace.png`. Disposable test PDFs were removed before deleting test accounts; the test document is intentionally no longer present in the live library.
- The earlier production attempt under the previous development-mode configuration uploaded/extracted successfully but timed out waiting for analysis. Its disposable account was also cleaned up. The successful result above is from the final cloud-mode deployment.
- A real invocation of the registered cleanup function removed a stale pending upload/document and a simulated late orphan/tombstone. Result: local `scratch/upload-cleanup-test.json`.

The original two overlapping browser-test processes wrote the same summary filename; the older timeout overwrote the successful run's JSON summary after it exited. The final success is recorded by its exit code, PASS output, observed database IDs above and the workspace screenshot. The harness now writes per-document evidence files and a separate latest-success file to prevent that collision.

## Exact files changed

- `.vercelignore` (excludes local credentials, scratch output and PDF test inputs from deployment)
- `app/api/documents/route.ts`
- `app/api/documents/[documentId]/complete/route.ts`
- `app/api/process-document/route.ts`
- `app/api/inngest/route.ts`
- `components/workspace/DocumentIntake.tsx`
- `components/dashboard/DocumentLibrary.tsx`
- `lib/client/document-upload.ts`
- `lib/server/document-upload.ts`
- `lib/server/documents.ts`
- `lib/uploads.ts`
- `lib/inngest/upload-cleanup.ts`
- `supabase/migrations/20261102194718_direct_document_uploads.sql`
- `package.json`
- `package-lock.json`
- `tests/document-upload.cjs`
- `tests/upload-cleanup.cjs`
- `docs/UPLOAD_413_FIX.md`

Billing, entitlements, quota reservation/finalization, AI analysis implementation and user deletion code were not changed. Upload cleanup extends orphan handling while preserving the storage-first deletion invariant. The user's untracked PDF is a test input and is not included in the change.
