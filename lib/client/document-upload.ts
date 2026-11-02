import { Upload } from 'tus-js-client';
import { validatePdf } from '@/lib/uploads';
import { createClient } from '@/lib/supabase/client';

async function jsonRequest(url: string, body?: unknown) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

export async function uploadDocument(file: File, userId: string, onProgress: (percent: number) => void) {
  const invalid = validatePdf(file.name, file.size, file.type);
  if (invalid) throw new Error(invalid);
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const key = `rfp-upload:${userId}:${hash}`;
  // Persist before the request so a lost authorization response cannot duplicate
  // the document. Only IDs are persisted, never signed upload credentials.
  let requestId = localStorage.getItem(key);
  if (!requestId) {
    requestId = crypto.randomUUID();
    localStorage.setItem(key, requestId);
  }
  const { response, data } = await jsonRequest('/api/documents', {
    requestId, filename: file.name, size: file.size, type: file.type,
  });
  if (!response.ok) throw new Error(data.error || 'Could not start upload. Retry with the same PDF.');
  const documentId = data.document.id as string;
  const completeUrl = `/api/documents/${documentId}/complete`;
  // Recover when Storage succeeded but the previous completion response was lost.
  let completion = await jsonRequest(completeUrl);
  if (!completion.response.ok && !data.verified) {
    await new Promise<void>((resolve, reject) => {
      const supabase = createClient();
      const upload = new Upload(file, {
        endpoint: data.endpoint,
        headers: { 'x-signature': data.token, 'x-upsert': 'false' },
        onBeforeRequest: async request => {
          // Forward credentials only; Storage validates the session and signed
          // path. Refresh through the browser client before every resumed chunk.
          const { data: { session } } = await supabase.auth.getSession();
          if (!session) throw new Error('Session expired. Sign in and select the same PDF to resume.');
          request.setHeader('Authorization', `Bearer ${session.access_token}`);
          request.setHeader('apikey', process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
        },
        chunkSize: 6 * 1024 * 1024,
        retryDelays: [0, 1000, 3000, 5000, 10000],
        uploadDataDuringCreation: true,
        removeFingerprintOnSuccess: true,
        fingerprint: async () => `rfp-tus:${userId}:${documentId}:${hash}`,
        metadata: {
          bucketName: data.bucket, objectName: data.path,
          contentType: 'application/pdf', cacheControl: '3600',
        },
        onProgress: (sent, total) => onProgress(Math.floor(sent / total * 100)),
        onError: reject,
        onSuccess: () => resolve(),
      });
      upload.findPreviousUploads().then(previous => {
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      }).catch(reject);
    });
    completion = await jsonRequest(completeUrl);
  }
  if (!completion.response.ok) throw new Error(completion.data.error || 'Upload verification failed. Retry with the same PDF.');
  onProgress(100);
  return documentId;
}
