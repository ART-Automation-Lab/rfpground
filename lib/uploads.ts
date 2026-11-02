export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const UPLOAD_BUCKET = 'rfps';
export const UPLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

export function validatePdf(filename: string, size: number, type: string) {
  if (!filename || filename.length > 255 || !filename.toLowerCase().endsWith('.pdf') ||
      (type && type !== 'application/pdf')) return 'Only PDF documents are supported.';
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PDF_BYTES) return 'PDF must be between 1 byte and 10 MB.';
  return null;
}

export function storageUploadEndpoint(base: string) {
  const url = new URL(base);
  if (url.hostname.endsWith('.supabase.co') && !url.hostname.endsWith('.storage.supabase.co')) {
    url.hostname = url.hostname.replace('.supabase.co', '.storage.supabase.co');
  }
  url.pathname = '/storage/v1/upload/resumable';
  return url.toString();
}
