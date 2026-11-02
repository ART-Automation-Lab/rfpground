import { inngest } from './client';
import { uploadAdmin } from '@/lib/server/document-upload';
import { UPLOAD_BUCKET } from '@/lib/uploads';

// Authorization expires after 24h from record creation (+2h signed token).
// TUS resources live at most 24h. The 72h grace period outlives both.
export const cleanupAbandonedUploads = inngest.createFunction(
  { id: 'cleanup-abandoned-uploads', concurrency: 1, triggers: [{ cron: '0 * * * *' }] },
  async ({ step }) => step.run('storage-first-cleanup', async () => {
    const admin = uploadAdmin();
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { data: docs, error } = await admin.from('documents')
      .select('id,user_id,storage_path').is('upload_verified_at', null)
      .lt('created_at', cutoff).limit(100);
    if (error) throw error;
    let removed = 0;
    for (const doc of docs || []) {
      if (!doc.storage_path.startsWith(`${doc.user_id}/`)) throw new Error('Invalid cleanup storage path');
      const { error: storageError } = await admin.storage.from(UPLOAD_BUCKET).remove([doc.storage_path]);
      if (storageError) throw storageError; // Preserve row on any Storage failure.
      const { error: dbError } = await admin.from('documents').delete()
        .eq('id', doc.id).is('upload_verified_at', null);
      if (dbError) throw dbError;
      removed++;
    }
    const { data: tombstones, error: cleanupError } = await admin.from('document_upload_cleanup')
      .select('storage_path').lt('cleanup_after', new Date().toISOString()).limit(100);
    if (cleanupError) throw cleanupError;
    for (const item of tombstones || []) {
      const { error: storageError } = await admin.storage.from(UPLOAD_BUCKET).remove([item.storage_path]);
      if (storageError) throw storageError;
      const { error: rowError } = await admin.from('document_upload_cleanup').delete().eq('storage_path', item.storage_path);
      if (rowError) throw rowError;
    }
    return { removed };
  }),
);
