import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { SupabaseClient } from '@supabase/supabase-js';
import { parsePdfBuffer } from '@/lib/processing/pdf-parser';
import { uploadAdmin, verifyUpload } from '@/lib/server/document-upload';

export const runtime = 'nodejs';
// Vercel allows up to 300s on hobby for standard functions if explicitly opted in, but 60s is a safe explicit value for an API route processing a 10MB PDF.
export const maxDuration = 60; 

export async function POST(request: Request) {
  let claimedDocumentId: string | null = null;
  let leaseUntil: string | null = null;
  try {
    const { document_id } = await request.json();

    if (!document_id) {
      return NextResponse.json({ error: 'Missing document_id' }, { status: 400 });
    }

    const supabase = await createClient();
    
    // 1. Verify session (done automatically by SSR client under the hood, but let's be explicit)
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 2. Query trusted storage_path from database
    const { data: document, error: docError } = await supabase
      .from('documents')
      .select('*')
      .eq('id', document_id)
      .eq('user_id', user.id)
      .single();

    if (docError || !document) {
      return NextResponse.json({ error: 'Document not found or access denied' }, { status: 404 });
    }

    if (['TEXT_EXTRACTED', 'OCR_REQUIRED', 'ANALYSIS_COMPLETE'].includes(document.status)) {
      const { count } = await supabase.from('document_pages').select('id', { count: 'exact', head: true }).eq('document_id', document_id);
      return NextResponse.json({ status: document.status, diagnostics: { total_pages: count || 0 } });
    }

    // Completion and direct extraction requests both verify the persisted object.
    // A missing/partial upload never transitions into PROCESSING.
    const admin = uploadAdmin();
    try {
      await verifyUpload(admin, document);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Upload verification required' }, { status: 409 });
    }
    leaseUntil = new Date(Date.now() + 90_000).toISOString();
    const { data: claimed, error: claimError } = await admin.from('documents')
      .update({ status: 'PROCESSING', extraction_lease_until: leaseUntil })
      .eq('id', document_id).eq('user_id', user.id)
      .in('status', ['UPLOADED', 'FAILED', 'PROCESSING'])
      .or(`extraction_lease_until.is.null,extraction_lease_until.lt.${new Date().toISOString()}`)
      .select('id').maybeSingle();
    if (claimError) throw new Error('Could not start extraction');
    if (!claimed) return NextResponse.json({ error: 'Extraction is already running. Retry shortly.' }, { status: 409 });
    claimedDocumentId = document_id;

    // 3. Download the private object
    const { data: fileBlob, error: downloadError } = await supabase.storage
      .from('rfps')
      .download(document.storage_path);

    if (downloadError || !fileBlob) {
      await markFailed(supabase, document_id);
      return NextResponse.json({ error: 'Failed to download file from secure storage' }, { status: 500 });
    }

    // Convert Blob to Node Buffer
    const arrayBuffer = await fileBlob.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // 4. Extract text
    const parseResult = await parsePdfBuffer(buffer);
    
    // 5. Extraction Quality Diagnostics & Heuristics
    const totalPages = parseResult.total_pages;
    const totalChars = parseResult.total_chars;
    
    let pagesWithMeaningfulText = 0;
    let pagesWithLittleOrNoText = 0;

    for (const page of parseResult.pages) {
      // Heuristic: A page with fewer than 20 characters is likely scanned, empty, or just a title page.
      if (page.char_count > 20) {
        pagesWithMeaningfulText++;
      } else {
        pagesWithLittleOrNoText++;
      }
    }

    let finalStatus = 'TEXT_EXTRACTED';
    
    // Heuristic: If more than 50% of the pages have practically no text, this document is mixed or scanned and requires OCR.
    if (totalPages === 0) {
      finalStatus = 'FAILED';
    } else if (pagesWithMeaningfulText === 0 || (pagesWithLittleOrNoText / totalPages) > 0.5) {
      finalStatus = 'OCR_REQUIRED';
    }

    if (finalStatus === 'FAILED') {
      await markFailed(supabase, document_id);
      return NextResponse.json({ error: 'PDF parsing failed to yield pages' }, { status: 400 });
    }

    // 6. Persist document_pages
    if (parseResult.pages.length > 0) {
      // We use upsert on (document_id, page_number) to ensure idempotency.
      const pagesToInsert = parseResult.pages.map(p => ({
        document_id,
        page_number: p.page_number,
        content: p.content,
        char_count: p.char_count
      }));

      const { error: insertError } = await supabase
        .from('document_pages')
        .upsert(pagesToInsert, { onConflict: 'document_id,page_number' });

      if (insertError) {
        await markFailed(supabase, document_id);
        console.error('Failed to insert pages:', insertError);
        return NextResponse.json({ error: 'Database persistence failed' }, { status: 500 });
      }
    }

    // 7. Update status
    const { error: statusError } = await supabase
      .from('documents')
      .update({ status: finalStatus })
      .eq('id', document_id);
    if (statusError) throw statusError;

    return NextResponse.json({ 
      status: finalStatus, 
      diagnostics: {
        total_pages: totalPages,
        total_chars: totalChars,
        meaningful_pages: pagesWithMeaningfulText,
        empty_pages: pagesWithLittleOrNoText
      }
    }, { status: 200 });

  } catch (err: unknown) {
    console.error('Process error:', err);
    if (claimedDocumentId) await markFailed(uploadAdmin(), claimedDocumentId);
    // Generic error returned to client to hide stack trace
    return NextResponse.json({ error: 'An unexpected processing error occurred' }, { status: 500 });
  } finally {
    if (claimedDocumentId && leaseUntil) {
      await uploadAdmin().from('documents').update({ extraction_lease_until: null })
        .eq('id', claimedDocumentId).eq('extraction_lease_until', leaseUntil);
    }
  }
}

async function markFailed(supabase: SupabaseClient, document_id: string) {
  await supabase
    .from('documents')
    .update({ status: 'FAILED' })
    .eq('id', document_id);
}
