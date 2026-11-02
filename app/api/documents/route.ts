import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getUserDocumentsPayload } from '@/lib/server/documents';
import { uploadAdmin, uploadUser } from '@/lib/server/document-upload';
import { storageUploadEndpoint, UPLOAD_BUCKET, UPLOAD_WINDOW_MS, validatePdf } from '@/lib/uploads';

export async function GET() {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const result = await getUserDocumentsPayload(user.id, supabase);
  return NextResponse.json(result, { status: result.status || 200 });
}

const uploadRequest = z.object({
  requestId: z.uuid(), filename: z.string().min(1).max(255),
  size: z.number().int().positive(), type: z.string(),
}).strict();

// Metadata only. PDF bytes go directly from the browser to private Storage.
export async function POST(request: Request) {
  try {
    const user = await uploadUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      return NextResponse.json({ error: 'Send PDF metadata as JSON; upload bytes directly to Storage.' }, { status: 415 });
    }
    const text = await request.text();
    if (text.length > 2048) return NextResponse.json({ error: 'Metadata too large' }, { status: 413 });
    const parsed = uploadRequest.safeParse(JSON.parse(text));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid upload metadata' }, { status: 400 });
    const input = parsed.data;
    const invalid = validatePdf(input.filename, input.size, input.type);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
    const admin = uploadAdmin();
    const { data: bucket, error: bucketError } = await admin.storage.getBucket(UPLOAD_BUCKET);
    if (bucketError || !bucket || bucket.public ||
        (bucket.file_size_limit && bucket.file_size_limit < input.size) ||
        (bucket.allowed_mime_types && !bucket.allowed_mime_types.includes('application/pdf'))) {
      return NextResponse.json({ error: 'Private PDF storage is not configured for this upload.' }, { status: 503 });
    }
    const { error: insertError } = await admin.from('documents').insert({
      id: input.requestId, user_id: user.id, original_filename: input.filename,
      storage_path: `${user.id}/${crypto.randomUUID()}.pdf`, size_bytes: input.size,
      status: 'UPLOADED', upload_verified_at: null,
    });
    if (insertError && insertError.code !== '23505') throw new Error('Could not prepare document. Retry with the same file.');
    const { data: doc, error: docError } = await admin.from('documents').select('*')
      .eq('id', input.requestId).eq('user_id', user.id).single();
    if (docError || !doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    if (doc.original_filename !== input.filename || Number(doc.size_bytes) !== input.size) {
      return NextResponse.json({ error: 'This upload belongs to a different file.' }, { status: 409 });
    }
    if (doc.upload_verified_at) return NextResponse.json({ document: doc, verified: true });
    if (Date.now() - Date.parse(doc.created_at) > UPLOAD_WINDOW_MS) {
      return NextResponse.json({ error: 'Upload expired. Delete the pending document and start again.' }, { status: 410 });
    }
    const { data: signed, error: signError } = await admin.storage.from(UPLOAD_BUCKET)
      .createSignedUploadUrl(doc.storage_path, { upsert: false });
    if (signError || !signed) throw new Error('Could not authorize upload. Retry with the same file.');
    return NextResponse.json({
      document: doc, verified: false, bucket: UPLOAD_BUCKET, path: doc.storage_path,
      token: signed.token, endpoint: storageUploadEndpoint(process.env.NEXT_PUBLIC_SUPABASE_URL!),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    console.error('Upload authorization failed:', error);
    return NextResponse.json({ error: 'Upload authorization failed. Retry with the same file.' }, { status: 500 });
  }
}
