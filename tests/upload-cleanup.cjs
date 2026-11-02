/* eslint-disable @typescript-eslint/no-require-imports */
// Exercises the registered production cron using only disposable test objects.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { createClient } = require('@supabase/supabase-js');
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } });
let userId;
let paths = [];

(async () => {
  const created = await admin.auth.admin.createUser({ email: `upload-cleanup-${randomUUID()}@example.com`, email_confirm: true });
  if (created.error) throw created.error;
  userId = created.data.user.id;
  const docId = randomUUID();
  paths = [`${userId}/${randomUUID()}.pdf`, `${userId}/${randomUUID()}.pdf`];
  const bytes = fs.readFileSync('real-world-docs/CDAC_CyberSecurity_RFP_Tender.pdf');
  for (const objectPath of paths) {
    const { error } = await admin.storage.from('rfps').upload(objectPath, bytes, { contentType: 'application/pdf', upsert: false });
    if (error) throw error;
  }
  const inserted = await admin.from('documents').insert({
    id: docId, user_id: userId, original_filename: 'cleanup-test.pdf', storage_path: paths[0],
    size_bytes: bytes.length, status: 'UPLOADED', upload_verified_at: null,
    created_at: new Date(Date.now() - 74 * 60 * 60 * 1000).toISOString(),
  });
  if (inserted.error) throw inserted.error;
  const tombstone = await admin.from('document_upload_cleanup').insert({ storage_path: paths[1], cleanup_after: new Date(Date.now() - 1000).toISOString() });
  if (tombstone.error) throw tombstone.error;
  const invoked = await fetch('https://api.inngest.com/v2/apps/bid-intel/functions/cleanup-abandoned-uploads/invoke', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.INNGEST_SIGNING_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: {} }),
  });
  assert.ok(invoked.ok, `Cleanup invocation failed: ${invoked.status} ${await invoked.text()}`);
  const deadline = Date.now() + 120000;
  let cleaned = false;
  while (Date.now() < deadline) {
    const document = await admin.from('documents').select('id').eq('id', docId).maybeSingle();
    const lateObject = await admin.from('document_upload_cleanup').select('storage_path').eq('storage_path', paths[1]).maybeSingle();
    if (document.error) throw document.error;
    if (lateObject.error) throw lateObject.error;
    if (!document.data && !lateObject.data) { cleaned = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(cleaned, 'Registered cleanup did not finish within two minutes');
  for (const objectPath of paths) assert.ok((await admin.storage.from('rfps').info(objectPath)).error);
  console.log('PASS: Registered production cron removes stale pending PDFs and their document records');
  console.log('PASS: Registered production cron removes late orphan objects and their cleanup tombstones');
  fs.writeFileSync('scratch/upload-cleanup-test.json', JSON.stringify({ completed: true, stalePendingRemoved: true, lateOrphanRemoved: true }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (!userId) return;
  const removed = await admin.storage.from('rfps').remove(paths);
  if (removed.error) { console.error('Storage cleanup failed:', removed.error.message); process.exitCode = 1; return; }
  const deleted = await admin.auth.admin.deleteUser(userId);
  if (deleted.error) { console.error('Test account cleanup failed:', deleted.error.message); process.exitCode = 1; }
  await admin.from('document_upload_cleanup').delete().in('storage_path', paths);
});
