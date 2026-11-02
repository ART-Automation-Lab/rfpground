import { NextResponse } from 'next/server';
import { uploadAdmin, uploadUser, verifyUpload } from '@/lib/server/document-upload';

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  const user = await uploadUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { documentId } = await context.params;
  const admin = uploadAdmin();
  const { data: doc } = await admin.from('documents').select('*')
    .eq('id', documentId).eq('user_id', user.id).single();
  if (!doc) return NextResponse.json({ error: 'Document not found' }, { status: 404 });
  try {
    await verifyUpload(admin, doc);
    return NextResponse.json({ documentId, verified: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Upload verification failed' }, { status: 409 });
  }
}
