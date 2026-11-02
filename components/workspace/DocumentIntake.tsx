'use client';

import React, { useState, useRef } from 'react';
import Link from 'next/link';
import { uploadDocument } from '@/lib/client/document-upload';
import { validatePdf } from '@/lib/uploads';
import { 
  UploadCloud, 
  Loader2, 
  CheckCircle2, 
  AlertTriangle, 
  Ban, 
  AlertCircle, 
  ArrowRight, 
} from 'lucide-react';

interface DocumentIntakeProps {
  userId: string;
  onAnalysisComplete: (documentId: string) => void;
  onCancel?: () => void;
}

type IntakeStage =
  | 'IDLE'
  | 'UPLOADING'
  | 'EXTRACTING'
  | 'OCR_REQUIRED'
  | 'QUALIFYING'
  | 'AMBIGUOUS_CONFIRMATION'
  | 'REJECTED'
  | 'ANALYSING'
  | 'ACCEPTED'
  | 'FAILED';

export default function DocumentIntake({
  userId,
  onAnalysisComplete,
  onCancel
}: DocumentIntakeProps) {
  const [stage, setStage] = useState<IntakeStage>('IDLE');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [, setRunId] = useState<string | null>(null);
  const [ambiguityReason, setAmbiguityReason] = useState<string | null>(null);
  const [extractedPagesCount, setExtractedPagesCount] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadVerified, setUploadVerified] = useState(false);
  const [extractionCompleted, setExtractionCompleted] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Validate and select file
  const handleFileSelect = (file: File) => {
    setErrorMessage(null);
    setSelectedFile(null);
    const invalid = validatePdf(file.name, file.size, file.type);
    if (invalid) { setErrorMessage(invalid); return; }

    setSelectedFile(file);
  };

  // Start the actual end-to-end processing pipeline
  const handleStartIntake = async () => {
    if (!selectedFile) return;

    try {
      setErrorMessage(null);
      setStage('UPLOADING');
      setUploadVerified(false);
      setExtractionCompleted(false);
      setUploadProgress(0);
      setStatusMessage('Starting secure upload...');
      const currentDocId = await uploadDocument(selectedFile, userId, percent => {
        setUploadProgress(percent);
        setStatusMessage(percent === 100 ? 'Upload transferred. Verifying stored PDF...' : `Uploading PDF: ${percent}%`);
      });

      setDocId(currentDocId);
      setUploadVerified(true);

      // 2. Process Document (Page text extraction + OCR heuristics)
      setStage('EXTRACTING');
      setStatusMessage('Upload completed and verified. Extracting document pages...');

      const processRes = await fetch('/api/process-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document_id: currentDocId })
      });

      if (!processRes.ok) {
        const pData = await processRes.json();
        throw new Error(pData.error || 'Text extraction failed.');
      }

      const processData = await processRes.json();
      setExtractionCompleted(true);
      setExtractedPagesCount(processData.diagnostics?.total_pages || 0);
      setStatusMessage('Text extraction completed. Starting qualification...');

      if (processData.status === 'OCR_REQUIRED') {
        setStage('OCR_REQUIRED');
        setStatusMessage('Document text density is extremely low. Scanned/raster PDF detected.');
        return;
      }

      // 4. Trigger Qualification & Analysis
      await triggerAnalysis(currentDocId, false);

    } catch (err: unknown) {
      console.error('Intake Pipeline Error:', err);
      setStage('FAILED');
      setErrorMessage(err instanceof Error ? err.message : 'An unexpected error occurred during processing.');
    }
  };

  // Trigger analysis execution
  const triggerAnalysis = async (documentId: string, userConfirmed: boolean) => {
    setStage('QUALIFYING');
    setStatusMessage('Evaluating procurement qualification gate...');

    const analyzeRes = await fetch('/api/analyze-document', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        document_id: documentId,
        user_confirmed: userConfirmed
      })
    });

    const analyzeData = await analyzeRes.json();

    if (!analyzeRes.ok) {
      if (analyzeRes.status === 403 && (analyzeData.code === 'QUOTA_EXCEEDED' || analyzeData.error?.includes('quota'))) {
        setErrorMessage(analyzeData.message || 'Analysis quota exceeded. Please upgrade to a paid plan for 15 analyses per month.');
        setStage('IDLE');
        return;
      }
      if (analyzeRes.status === 422 && analyzeData.ambiguous) {
        setErrorMessage(null);
        setStage('AMBIGUOUS_CONFIRMATION');
        setAmbiguityReason(analyzeData.reason || 'Document structure is non-standard.');
        return;
      }
      if (analyzeRes.status === 422 && analyzeData.rejected) {
        setErrorMessage(null);
        setStage('REJECTED');
        setAmbiguityReason(analyzeData.reason || 'Document does not appear to be a procurement opportunity.');
        return;
      }
      throw new Error(analyzeData.error || 'Failed to dispatch analysis run.');
    }

    if (analyzeData.status === 'AI_REJECTED' || (analyzeData.success === false && analyzeData.status === 'AI_REJECTED')) {
      setErrorMessage(null);
      setStage('REJECTED');
      setAmbiguityReason(analyzeData.reason || 'Document does not appear to be a procurement opportunity.');
      return;
    }

    if (analyzeData.status === 'AI_AMBIGUOUS' || (analyzeData.success === false && analyzeData.status === 'AI_AMBIGUOUS')) {
      setErrorMessage(null);
      setStage('AMBIGUOUS_CONFIRMATION');
      setAmbiguityReason(analyzeData.reason || 'Document classification uncertain, requires user confirmation');
      return;
    }

    const currentRunId = analyzeData.runId || analyzeData.run_id;
    if (!currentRunId) {
      throw new Error(analyzeData.error || 'Failed to initialize analysis run ID.');
    }

    setRunId(currentRunId);
    setStage('ACCEPTED');
    setStatusMessage('Tender accepted. Analysis is running asynchronously in the background.');

    // Poll in background in case user stays on screen
    pollAnalysisStatus(currentRunId, documentId);
  };

  // Poll analysis run status
  const pollAnalysisStatus = (activeRunId: string, activeDocId: string) => {
    if (!activeRunId || activeRunId === 'undefined') {
      console.warn('Cannot poll analysis status without a valid runId');
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/analysis-status?runId=${activeRunId}`);
        if (!res.ok) {
          if (res.status === 404 || res.status === 400) {
            clearInterval(interval);
            setStage('FAILED');
            setErrorMessage('Analysis run was not found. Please try uploading again.');
          }
          return;
        }

        const data = await res.json();
        
        if (data.status === 'COMPLETED') {
          clearInterval(interval);
          onAnalysisComplete(activeDocId);
        } else if (data.status === 'REJECTED' || data.qualification_status === 'AI_REJECTED') {
          clearInterval(interval);
          setErrorMessage(null);
          setAmbiguityReason(data.qualification_reason || data.error || 'Document does not appear to be a procurement opportunity.');
          setStage('REJECTED');
        } else if (data.status === 'AMBIGUOUS' || data.qualification_status === 'AI_AMBIGUOUS') {
          clearInterval(interval);
          setErrorMessage(null);
          setAmbiguityReason(data.qualification_reason || data.error || 'Document classification uncertain, requires user confirmation.');
          setStage('AMBIGUOUS_CONFIRMATION');
        } else if (data.status === 'FAILED') {
          clearInterval(interval);
          if (data.qualification_status === 'AI_REJECTED') {
            setErrorMessage(null);
            setAmbiguityReason(data.qualification_reason || data.error || 'Document does not appear to be a procurement opportunity.');
            setStage('REJECTED');
          } else {
            setStage('FAILED');
            setErrorMessage(data.error || data.last_error || 'Analysis execution encountered a server error.');
          }
        } else {
          setStatusMessage(`Analysing document pages (Stage: ${data.status})...`);
        }
      } catch (e) {
        console.error('Polling error:', e);
      }
    }, 2500);
  };

  return (
    <div className="max-w-2xl mx-auto p-6 md:p-8 my-8 bg-white border border-[#D9DEE5] rounded-sm shadow-xs">
      
      {/* Header */}
      <div className="pb-4 border-b border-[#D9DEE5] mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-[18px] font-bold text-[#111827]">
            Tender Intake & Processing
          </h2>
          <p className="text-[13px] text-[#667085] mt-0.5">
            Upload a procurement tender or RFP (PDF format, up to 10 MB).
          </p>
          <p className="text-[12px] text-[#667085] mt-1">
            Interrupted upload? Select the same PDF to resume or recover it.
          </p>
        </div>

        {onCancel && stage === 'IDLE' && (
          <button
            onClick={onCancel}
            className="text-[12px] font-semibold text-[#667085] hover:text-[#111827]"
          >
            Cancel
          </button>
        )}
      </div>

      {/* Error Alert - only shown when in IDLE file selection mode */}
      {errorMessage && stage === 'IDLE' && (
        <div className="mb-6 p-4 bg-[#FEF3F2] border border-[#FECDCA] rounded-sm text-[13px] text-[#B42318] flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="font-bold">Error:</span>
            <span>{errorMessage}</span>
          </div>
          {errorMessage.toLowerCase().includes('quota') && (
            <Link
              href="/subscription"
              className="shrink-0 px-2.5 py-1 bg-[#B42318] hover:bg-[#912018] text-white text-[12px] font-medium rounded transition-colors"
            >
              View Plans
            </Link>
          )}
        </div>
      )}

      {/* STAGE 1: IDLE / FILE SELECTION */}
      {stage === 'IDLE' && (
        <div className="flex flex-col gap-6">
          
          {/* Dropzone */}
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleFileSelect(e.dataTransfer.files[0]);
              }
            }}
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-[#D9DEE5] hover:border-[#3157D5] bg-[#F5F6F4] hover:bg-white rounded-sm p-8 text-center cursor-pointer transition-all flex flex-col items-center justify-center"
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files[0]) {
                  handleFileSelect(e.target.files[0]);
                }
              }}
            />

            <div className="w-10 h-10 rounded-full bg-white border border-[#D9DEE5] flex items-center justify-center mb-3 text-[#3157D5] shadow-2xs">
              <UploadCloud className="w-5 h-5" strokeWidth={1.75} />
            </div>

            {selectedFile ? (
              <div className="flex flex-col items-center">
                <span className="text-[14px] font-semibold text-[#111827]">
                  {selectedFile.name}
                </span>
                <span className="text-[12px] font-mono text-[#667085] mt-0.5">
                  {(selectedFile.size / (1024 * 1024)).toFixed(2)} MB · Ready for analysis
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center">
                <span className="text-[14px] font-semibold text-[#111827]">
                  Click to select or drag and drop tender PDF
                </span>
                <span className="text-[12px] text-[#667085] mt-1">
                  PDF format only · Maximum 10 MB
                </span>
              </div>
            )}
          </div>

          {/* Action Button */}
          <button
            disabled={!selectedFile}
            onClick={handleStartIntake}
            className="w-full py-2.5 px-4 bg-[#3157D5] hover:bg-[#2546B8] disabled:bg-gray-200 disabled:text-gray-400 text-white font-semibold text-[13.5px] rounded-sm transition-colors shadow-xs flex items-center justify-center gap-2 cursor-pointer disabled:cursor-not-allowed"
          >
            <span>Start Tender Ingestion & Analysis</span>
            <ArrowRight className="w-4 h-4" strokeWidth={2} />
          </button>
        </div>
      )}

      {/* STAGE 2: PROCESSING (UPLOADING / EXTRACTING / QUALIFYING / ANALYSING) */}
      {(stage === 'UPLOADING' || stage === 'EXTRACTING' || stage === 'QUALIFYING' || stage === 'ANALYSING') && (
        <div className="p-8 text-center flex flex-col items-center justify-center bg-[#F5F6F4] border border-[#D9DEE5] rounded-sm">
          <Loader2 className="w-8 h-8 text-[#3157D5] animate-spin mb-4" strokeWidth={2} />
          
          <h3 className="text-[15px] font-bold text-[#111827] mb-1">
            {stage === 'UPLOADING' && 'Uploading Tender Document...'}
            {stage === 'EXTRACTING' && 'Extracting Document Pages...'}
            {stage === 'QUALIFYING' && 'Evaluating Procurement Qualification...'}
            {stage === 'ANALYSING' && 'Running Targeted Extraction & Evidence Verification...'}
          </h3>

          <p className="text-[13px] text-[#667085] max-w-md mb-3">
            {statusMessage}
          </p>
          {stage === 'UPLOADING' && (
            <progress aria-label="PDF upload progress" value={uploadProgress} max={100} className="w-full max-w-sm mb-3" />
          )}
          {uploadVerified && <p className="text-[12px] text-[#027A48] mb-2">Upload completed and verified</p>}
          {extractionCompleted && <p className="text-[12px] text-[#027A48] mb-2">Text extraction completed</p>}

          {extractedPagesCount > 0 && (
            <span className="text-[11.5px] font-mono text-[#475467] bg-white px-2.5 py-1 rounded border border-[#D9DEE5]">
              {extractedPagesCount} Pages Extracted
            </span>
          )}
        </div>
      )}

      {/* STAGE 2.5: ACCEPTED & QUEUED IN BACKGROUND */}
      {stage === 'ACCEPTED' && (
        <div className="p-6 bg-[#ECFDF3] border border-[#ABEFC6] rounded-sm">
          <div className="flex items-center gap-2 mb-2 text-[#027A48]">
            <CheckCircle2 className="w-4 h-4 text-[#027A48]" strokeWidth={2} />
            <span className="font-bold text-[14px]">Tender Accepted & Queued</span>
          </div>
          <p className="text-[13.5px] font-semibold text-[#054F31] mb-1">
            {selectedFile?.name}
          </p>
          <p className="text-[12.5px] text-[#067647] leading-relaxed mb-4">
            The document has been queued for analysis in the background. You can continue working, upload another tender, or inspect the analysis queue.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                setSelectedFile(null);
                setStage('IDLE');
              }}
              className="px-4 py-2 bg-[#027A48] hover:bg-[#05603A] text-white font-semibold text-[12.5px] rounded-sm transition-colors cursor-pointer shadow-xs"
            >
              + Upload Another Tender
            </button>
            <button
              onClick={() => {
                if (docId) {
                  onAnalysisComplete(docId);
                } else if (onCancel) {
                  onCancel();
                }
              }}
              className="px-4 py-2 bg-white border border-[#D9DEE5] text-[#344054] font-semibold text-[12.5px] rounded-sm hover:bg-gray-50 cursor-pointer shadow-2xs flex items-center gap-1.5"
            >
              <span>Go to Workspace</span>
              <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          </div>
        </div>
      )}

      {/* STAGE 3: OCR REQUIRED WARNING */}
      {stage === 'OCR_REQUIRED' && (
        <div className="p-6 bg-[#FFFAEB] border border-[#FEDF89] rounded-sm">
          <div className="flex items-center gap-2 mb-2 text-[#B54708]">
            <AlertTriangle className="w-4 h-4 text-[#B54708]" strokeWidth={2} />
            <span className="font-bold text-[14px]">OCR Required</span>
          </div>
          <p className="text-[13px] text-[#7A2E0E] leading-relaxed mb-4">
            This document contains scanned image pages or extremely low text density. The current text extractor yielded insufficient character data. Optical Character Recognition (OCR) is required before this document can be analyzed.
          </p>
          <button
            onClick={() => setStage('IDLE')}
            className="px-4 py-2 bg-white border border-[#D9DEE5] rounded-sm text-[12.5px] font-semibold text-[#344054] hover:bg-gray-50 cursor-pointer"
          >
            Select Another Document
          </button>
        </div>
      )}

      {/* STAGE 4: AMBIGUOUS QUALIFICATION GATE */}
      {stage === 'AMBIGUOUS_CONFIRMATION' && (
        <div className="p-6 bg-[#FFFAEB] border border-[#FEDF89] rounded-sm">
          <div className="flex items-center gap-2 mb-2 text-[#B54708]">
            <AlertTriangle className="w-4 h-4 text-[#B54708]" strokeWidth={2} />
            <span className="font-bold text-[14px]">Document Qualification Ambiguous</span>
          </div>
          <p className="text-[13px] text-[#7A2E0E] leading-relaxed mb-2">
            The automated qualification gate classified this document with low confidence.
          </p>
          {ambiguityReason && (
            <p className="text-[12px] font-mono text-[#7A2E0E] bg-white/70 p-2.5 rounded border border-[#FEDF89] mb-4">
              Reason: {ambiguityReason}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              onClick={() => docId && triggerAnalysis(docId, true)}
              className="px-4 py-2 bg-[#3157D5] text-white font-semibold text-[12.5px] rounded-sm hover:bg-[#2546B8] cursor-pointer shadow-xs"
            >
              Confirm as Procurement Opportunity & Proceed
            </button>
            <button
              onClick={() => setStage('IDLE')}
              className="px-3 py-2 bg-white border border-[#D9DEE5] text-[#344054] font-semibold text-[12.5px] rounded-sm hover:bg-gray-50 cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* STAGE 5: REJECTED DOCUMENT GATE (MATCHING QUEUED SIDE PANEL DESIGN & ACTIONS) */}
      {stage === 'REJECTED' && (
        <div className="p-6 bg-[#FEF3F2] border border-[#FECDCA] rounded-sm">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div>
              <div className="flex items-center gap-2 text-[#B42318] mb-1">
                <Ban className="w-4 h-4 text-[#B42318]" strokeWidth={2} />
                <span className="font-bold text-[14px]">Document Rejected</span>
              </div>
              {selectedFile && (
                <p className="text-[13px] font-semibold text-[#111827] truncate">
                  {selectedFile.name}
                </p>
              )}
            </div>
            <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded border bg-white text-[#B42318] border-[#FECDCA] shrink-0">
              REJECTED
            </span>
          </div>

          <p className="text-[12.5px] text-[#912018] mb-3 leading-relaxed">
            This document was identified as a non-procurement document (such as an internal resume, invoice, brochure, or marketing material) and cannot be processed as a tender.
          </p>

          {ambiguityReason && (
            <div className="p-3 bg-white/80 rounded border border-[#FECDCA] mb-4">
              <div className="text-[11px] font-bold text-[#B42318] uppercase tracking-wider mb-1">
                Reason
              </div>
              <p className="text-[12px] font-mono text-[#912018] leading-relaxed">
                {ambiguityReason}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between pt-3 border-t border-[#FECDCA]/60">
            <button
              onClick={() => {
                setSelectedFile(null);
                setDocId(null);
                setRunId(null);
                setErrorMessage(null);
                setAmbiguityReason(null);
                setStage('IDLE');
              }}
              className="px-4 py-2 bg-white border border-[#D9DEE5] text-[#344054] font-semibold text-[12.5px] rounded-sm hover:bg-gray-50 cursor-pointer shadow-2xs"
            >
              Upload Another Document
            </button>
            {docId && (
              <button
                onClick={() => triggerAnalysis(docId, true)}
                className="px-4 py-2 bg-[#111827] hover:bg-black text-white font-semibold text-[12.5px] rounded-sm transition-colors cursor-pointer shadow-xs flex items-center gap-1.5"
              >
                <span>Override & Analyze</span>
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* STAGE 6: FAILURE STATE (MATCHING QUEUED SIDE PANEL DESIGN & ACTIONS) */}
      {stage === 'FAILED' && (
        <div className="p-6 bg-[#FEF3F2] border border-[#FECDCA] rounded-sm">
          <div className="flex items-start justify-between gap-2 mb-2">
            <div>
              <div className="flex items-center gap-2 text-[#B42318] mb-1">
                <AlertCircle className="w-4 h-4 text-[#B42318]" strokeWidth={2} />
                <span className="font-bold text-[14px]">{uploadVerified ? 'Processing Failed' : 'Upload Failed'}</span>
              </div>
              {selectedFile && (
                <p className="text-[13px] font-semibold text-[#111827] truncate">
                  {selectedFile.name}
                </p>
              )}
            </div>
            <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded border bg-white text-[#B42318] border-[#FECDCA] shrink-0">
              FAILED
            </span>
          </div>

          <p className="text-[12.5px] text-[#912018] mb-4 leading-relaxed">
            {errorMessage || 'Analysis execution encountered an unexpected error.'}
          </p>

          <div className="flex items-center justify-between pt-3 border-t border-[#FECDCA]/60">
            <button
              onClick={() => {
                setSelectedFile(null);
                setDocId(null);
                setRunId(null);
                setErrorMessage(null);
                setAmbiguityReason(null);
                setStage('IDLE');
              }}
              className="px-4 py-2 bg-white border border-[#D9DEE5] text-[#344054] font-semibold text-[12.5px] rounded-sm hover:bg-gray-50 cursor-pointer shadow-2xs"
            >
              Upload Another Document
            </button>
            {selectedFile && (
              <button
                onClick={handleStartIntake}
                className="px-4 py-2 bg-[#111827] hover:bg-black text-white font-semibold text-[12.5px] rounded-sm transition-colors cursor-pointer shadow-xs flex items-center gap-1.5"
              >
                <span>Retry Upload & Processing</span>
                <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
