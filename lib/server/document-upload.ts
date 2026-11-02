import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { UPLOAD_BUCKET, MAX_PDF_BYTES } from '@/lib/uploads';

export function uploadAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Storage authorization is unavailable.');
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function uploadUser(request: Request) {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ')) {
    const { data: { user }, error } = await uploadAdmin().auth.getUser(header.slice(7));
    if (!error && user) return user;
  }
  const { createClient } = await import('@/lib/supabase/server');
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  return error ? null : user;
}

export interface UploadDocument {
  id: string;
  user_id: string;
  storage_path: string;
  size_bytes: number;
  original_filename: string;
  upload_verified_at: string | null;
  created_at: string;
}

// No object bytes are downloaded here. The trusted row supplies the exact path,
// owner and expected size; Storage supplies persisted object metadata.
export async function verifyUpload(admin: ReturnType<typeof uploadAdmin>, doc: UploadDocument) {
  if (!doc.upload_verified_at && Date.now() - Date.parse(doc.created_at) > 48 * 60 * 60 * 1000) {
    throw new Error('Upload recovery expired. Delete this pending document and start again.');
  }
  if (!doc.storage_path.startsWith(`${doc.user_id}/`) || !doc.storage_path.endsWith('.pdf')) {
    throw new Error('Invalid document storage context.');
  }
  const { data, error } = await admin.storage.from(UPLOAD_BUCKET).info(doc.storage_path);
  if (error || !data) throw new Error('Upload is not yet available. Retry completion or resume uploading.');
  if (data.bucketId !== UPLOAD_BUCKET || data.name !== doc.storage_path ||
      Number(data.size) !== Number(doc.size_bytes) || Number(data.size) > MAX_PDF_BYTES ||
      data.contentType !== 'application/pdf') {
    throw new Error('Stored PDF does not match the authorized document metadata.');
  }
  if (!doc.upload_verified_at) {
    const { data: confirmed, error: updateError } = await admin.from('documents')
      .update({ upload_verified_at: new Date().toISOString() })
      .eq('id', doc.id).eq('user_id', doc.user_id).eq('storage_path', doc.storage_path)
      .select('id').maybeSingle();
    if (updateError || !confirmed) throw new Error('Could not confirm upload. Retry completion.');
  }
}
