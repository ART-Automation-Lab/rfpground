'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import LogoutButton from '@/app/dashboard/LogoutButton';
import DocumentIntake from '@/components/workspace/DocumentIntake';
import BillingBadge from '@/components/billing/BillingBadge';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus,
  Search,
  Check,
  AlertTriangle,
  Ban,
  CheckCircle,
  Trash2,
  ArrowRight,
  X,
  FileText,
  Loader2,
  ShieldAlert,
  Database,
  FileCheck,
  HardDrive
} from 'lucide-react';

export interface LibraryDocument {
  id: string;
  original_filename: string;
  size_bytes: number;
  status: string;
  operational_status: string;
  qualification_status: string | null;
  qualification_reason: string | null;
  document_type: string | null;
  created_at: string;
  total_pages: number;
  evaluated_pages_count?: number;
  recommended_action?: string;
  latest_run?: {
    id: string;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    last_error: string | null;
  } | null;
}

interface DocumentLibraryProps {
  userId: string;
  userEmail?: string | null;
  initialDocuments?: LibraryDocument[];
}

type FilterTab = 'ALL' | 'READY' | 'PROCESSING' | 'REVIEW' | 'FAILED' | 'REJECTED';

export default function DocumentLibrary({ userId, userEmail, initialDocuments }: DocumentLibraryProps) {
  const router = useRouter();
  const [documents, setDocuments] = useState<LibraryDocument[]>(initialDocuments || []);
  const [isLoading, setIsLoading] = useState<boolean>(!initialDocuments);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [activeTab, setActiveTab] = useState<FilterTab>('ALL');
  const [isUploadModalOpen, setIsUploadModalOpen] = useState<boolean>(false);

  // Deletion state
  const [deletingDoc, setDeletingDoc] = useState<LibraryDocument | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Library fetch error state (Law 1: Error != Empty)
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Escape key and body-scroll lock for modals
  useEffect(() => {
    const isAnyModalOpen = isUploadModalOpen || Boolean(deletingDoc);
    if (!isAnyModalOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isUploadModalOpen) setIsUploadModalOpen(false);
        if (deletingDoc && !isDeleting) {
          setDeletingDoc(null);
          setDeleteError(null);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isUploadModalOpen, deletingDoc, isDeleting]);

  // Fetch all documents for this user
  const fetchDocuments = useCallback(async (isInitial = false) => {
    try {
      if (isInitial && !initialDocuments) {
        setIsLoading(true);
      }
      setFetchError(null);
      const res = await fetch('/api/documents');
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        // Use user-safe message; do not expose internal/stack details
        const safeMsg = errData.error && typeof errData.error === 'string' && !errData.error.includes('at ')
          ? errData.error
          : 'Unable to communicate with the tender service. Please try again.';
        setFetchError(safeMsg);
        return;
      }
      const data = await res.json();
      setDocuments(data.documents || []);
      setFetchError(null);
    } catch {
      setFetchError('A network error occurred while retrieving your tenders. Please check your connection.');
    } finally {
      setIsLoading(false);
    }
  }, [initialDocuments]);

  useEffect(() => {
    if (!initialDocuments) {
      fetchDocuments(true);
    }
  }, [fetchDocuments, initialDocuments]);


  const handleDeleteConfirm = async () => {
    if (!deletingDoc) return;
    try {
      setIsDeleting(true);
      setDeleteError(null);
      const res = await fetch(`/api/documents/${deletingDoc.id}`, {
        method: 'DELETE'
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Storage deletion failed or DB deletion failed: keep document visible and show truthful error
        setDeleteError(data.error || `Deletion failed with status ${res.status}. Your document was not removed.`);
        return;
      }

      // Deletion succeeded on backend:
      // Remove from local React state
      setDocuments((prev) => prev.filter((d) => d.id !== deletingDoc.id));
      setDeletingDoc(null);
    } catch (err: any) {
      setDeleteError(err.message || 'Network error occurred while requesting deletion.');
    } finally {
      setIsDeleting(false);
    }
  };

  // Tab counts
  const tabCounts = useMemo(() => {
    const counts = {
      ALL: documents.length,
      READY: 0,
      PROCESSING: 0,
      REVIEW: 0,
      FAILED: 0,
      REJECTED: 0,
    };

    documents.forEach((doc) => {
      const opStatus = doc.operational_status?.toUpperCase() || doc.status?.toUpperCase();
      const qualStatus = doc.qualification_status?.toUpperCase();

      if (opStatus === 'COMPLETED' || opStatus === 'ANALYSIS_COMPLETE') {
        counts.READY++;
      } else if (qualStatus === 'AI_REJECTED' || opStatus === 'REJECTED') {
        counts.REJECTED++;
      } else if (qualStatus === 'AI_AMBIGUOUS' || opStatus === 'AMBIGUOUS') {
        counts.REVIEW++;
      } else if (opStatus === 'FAILED' || opStatus === 'ERROR') {
        counts.FAILED++;
      } else {
        // Any active extraction/analysis status
        counts.PROCESSING++;
      }
    });

    return counts;
  }, [documents]);

  // Filtered documents
  const filteredDocuments = useMemo(() => {
    return documents.filter((doc) => {
      // Tab filter
      const opStatus = doc.operational_status?.toUpperCase() || doc.status?.toUpperCase();
      const qualStatus = doc.qualification_status?.toUpperCase();

      if (activeTab === 'READY') {
        if (opStatus !== 'COMPLETED' && opStatus !== 'ANALYSIS_COMPLETE') return false;
      } else if (activeTab === 'PROCESSING') {
        const isReady = opStatus === 'COMPLETED' || opStatus === 'ANALYSIS_COMPLETE';
        const isRejected = qualStatus === 'AI_REJECTED' || opStatus === 'REJECTED';
        const isReview = qualStatus === 'AI_AMBIGUOUS' || opStatus === 'AMBIGUOUS';
        const isFailed = opStatus === 'FAILED' || opStatus === 'ERROR';
        if (isReady || isRejected || isReview || isFailed) return false;
      } else if (activeTab === 'REVIEW') {
        if (qualStatus !== 'AI_AMBIGUOUS' && opStatus !== 'AMBIGUOUS') return false;
      } else if (activeTab === 'FAILED') {
        if (opStatus !== 'FAILED' && opStatus !== 'ERROR') return false;
      } else if (activeTab === 'REJECTED') {
        if (qualStatus !== 'AI_REJECTED' && opStatus !== 'REJECTED') return false;
      }

      // Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesName = doc.original_filename.toLowerCase().includes(q);
        const matchesReason = (doc.qualification_reason || '').toLowerCase().includes(q);
        const matchesType = (doc.document_type || '').toLowerCase().includes(q);
        if (!matchesName && !matchesReason && !matchesType) return false;
      }

      return true;
    });
  }, [documents, activeTab, searchQuery]);

  // Format relative timestamp
  const formatTimeAgo = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / (1000 * 60));
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays === 1) return 'Yesterday';
      if (diffDays < 7) return `${diffDays}d ago`;
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return dateString;
    }
  };

  const handleUploadComplete = (documentId: string) => {
    setIsUploadModalOpen(false);
    fetchDocuments();
    router.push(`/documents/${documentId}`);
  };

  return (
    <div className="min-h-screen bg-[#F5F6F4] flex flex-col font-sans text-[#111827]">
      {/* 1. TOP HEADER */}
      <header className="h-14 bg-white border-b border-[#D9DEE5] px-4 md:px-6 flex items-center justify-between sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center shrink-0 hover:opacity-85 transition-opacity cursor-pointer"
            title="RFPground Homepage"
          >
            <Image
              src="/brand-assets/navbar-logo.png"
              alt="RFPground"
              width={160}
              height={40}
              className="h-9 sm:h-9.5 md:h-10 w-auto object-contain shrink-0"
              priority
            />
          </Link>
          <span className="h-4 w-px bg-[#D9DEE5] shrink-0" />
          <span className="text-[13px] font-semibold text-[#475467]">
            Document Library
          </span>
        </div>

        <div className="flex items-center gap-3">
          <BillingBadge />
          <Link
            href="/subscription"
            className="text-[12px] font-medium text-[#475467] hover:text-[#101828] bg-[#F2F4F7] hover:bg-[#EAECF0] border border-[#D0D5DD] px-2.5 py-1 rounded transition-colors hidden sm:inline"
          >
            Plans & Pricing
          </Link>
          {userEmail && (
            <span className="text-[12px] font-medium text-[#667085] hidden md:inline">
              {userEmail}
            </span>
          )}
          <LogoutButton />
        </div>
      </header>

      {/* 2. MAIN WORKSPACE CONTAINER */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 md:px-6 py-8 flex flex-col gap-6">
        {/* Title Bar & Action */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-[22px] font-bold text-[#111827] tracking-tight">
                Documents
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[12px] font-semibold bg-[#E4E7EC] text-[#344054]">
                {documents.length}
              </span>
            </div>
            <p className="text-[13px] text-[#667085] mt-0.5">
              All documents uploaded and evaluated across your workspace
            </p>
          </div>

          <button
            onClick={() => setIsUploadModalOpen(true)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#3157D5] hover:bg-[#2544ab] active:scale-[0.98] active:translate-y-px text-white text-[13px] font-semibold rounded-md shadow-xs transition-all duration-150 ease-out cursor-pointer shrink-0 motion-reduce:transform-none"
          >
            <Plus className="w-4 h-4" strokeWidth={2} />
            <span>Upload Tender</span>
          </button>
        </div>

        {/* Search & Filter Strip */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-white p-2.5 rounded-lg border border-[#D9DEE5] shadow-2xs">
          {/* Search Input */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[#98A2B3]" strokeWidth={2} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search documents by name, type, or notes..."
              className="w-full pl-9 pr-4 py-1.5 text-[13px] text-[#111827] bg-[#F5F6F4]/60 rounded border-0 focus:ring-1 focus:ring-[#3157D5] placeholder:text-[#98A2B3]"
            />
          </div>

          {/* Filter Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
            {(
              [
                { id: 'ALL', label: 'All', count: tabCounts.ALL },
                { id: 'READY', label: 'Ready', count: tabCounts.READY },
                { id: 'PROCESSING', label: 'Processing', count: tabCounts.PROCESSING },
                { id: 'REVIEW', label: 'Review', count: tabCounts.REVIEW },
                { id: 'FAILED', label: 'Failed', count: tabCounts.FAILED },
                { id: 'REJECTED', label: 'Rejected', count: tabCounts.REJECTED },
              ] as const
            ).map((tab) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-2.5 py-1 text-[12px] font-semibold rounded-md transition-all duration-150 ease-out cursor-pointer shrink-0 flex items-center gap-1.5 active:scale-[0.98] motion-reduce:transform-none ${isActive
                    ? 'bg-[#3157D5] text-white shadow-2xs'
                    : 'text-[#475467] hover:bg-[#F5F6F4] hover:text-[#111827]'
                    }`}
                >
                  <span>{tab.label}</span>
                  <span
                    className={`text-[10.5px] px-1.5 py-0.2 rounded-full ${isActive ? 'bg-white/20 text-white' : 'bg-[#E4E7EC] text-[#475467]'
                      }`}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Documents Grid / List */}
        <div className="flex flex-col gap-2.5">
          {isLoading ? (
            <div className="bg-white border border-[#D9DEE5] rounded-lg p-12 flex flex-col items-center justify-center text-center">
              <Loader2 className="w-7 h-7 text-[#3157D5] animate-spin mb-3" strokeWidth={2} />
              <span className="text-[13px] font-semibold text-[#111827]">
                Loading Document Library...
              </span>
              <span className="text-[11.5px] text-[#667085] mt-0.5">
                Fetching verified tender records
              </span>
            </div>
          ) : fetchError ? (
            /* Law 1: Error != Empty. Render explicit error state when fetch fails */
            <div className="bg-white border border-[#FECDCA] rounded-lg p-10 flex flex-col items-center justify-center text-center shadow-xs">
              <div className="w-12 h-12 rounded-full bg-[#FEF3F2] border border-[#FECDCA] text-[#B42318] flex items-center justify-center mb-3">
                <AlertTriangle className="w-6 h-6 text-[#D92D20]" strokeWidth={2} />
              </div>
              <h3 className="text-[15px] font-bold text-[#111827]">
                Unable to Load Document Library
              </h3>
              <p className="text-[13px] text-[#B42318] max-w-md mt-1 mb-1 font-medium">
                {fetchError}
              </p>
              <p className="text-[12px] text-[#475467] max-w-sm mb-5">
                Your previously uploaded tenders and analyses are safe in our database.
              </p>
              <button
                type="button"
                onClick={() => fetchDocuments()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-[#D92D20] hover:bg-[#B42318] text-white text-[12.5px] font-semibold rounded-md shadow-xs transition-colors cursor-pointer"
              >
                <span>Retry Loading Tenders</span>
              </button>

            </div>
          ) : filteredDocuments.length === 0 ? (
            <div className="bg-white border border-[#D9DEE5] rounded-lg p-12 flex flex-col items-center justify-center text-center">
              <div className="w-10 h-10 rounded-full bg-[#F5F6F4] flex items-center justify-center text-[#667085] mb-3">
                <FileText className="w-5 h-5 text-[#667085]" strokeWidth={1.75} />
              </div>
              <h3 className="text-[14px] font-bold text-[#111827]">
                {searchQuery ? 'No matching documents found' : 'No documents in this view'}
              </h3>
              <p className="text-[12px] text-[#667085] max-w-sm mt-1 mb-4">
                {searchQuery
                  ? `No tender matched "${searchQuery}". Try searching for another filename or qualification status.`
                  : 'Get started by uploading a Request for Proposal (RFP) to extract findings and verify requirements.'}
              </p>
              {!searchQuery && (
                <button
                  onClick={() => setIsUploadModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 bg-[#3157D5] hover:bg-[#2544ab] text-white text-[12.5px] font-semibold rounded-md shadow-xs transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" strokeWidth={2} />
                  <span>Upload Your First RFP</span>
                </button>
              )}
            </div>
          ) : (
            filteredDocuments.map((doc) => {
              const opStatus = doc.operational_status?.toUpperCase() || doc.status?.toUpperCase();
              const isCompleted = opStatus === 'COMPLETED' || opStatus === 'ANALYSIS_COMPLETE';
              const isFailed = opStatus === 'FAILED' || opStatus === 'ERROR';
              const isAmbiguous = doc.qualification_status === 'AI_AMBIGUOUS' || opStatus === 'AMBIGUOUS';
              const isRejected = doc.qualification_status === 'AI_REJECTED' || opStatus === 'REJECTED';
              const isProcessing =
                (opStatus === 'PROCESSING' ||
                  opStatus === 'EXTRACTING' ||
                  opStatus === 'ANALYSING' ||
                  opStatus === 'QUALIFYING' ||
                  opStatus === 'QUEUED') &&
                !isCompleted &&
                !isFailed;

              return (
                <div
                  key={doc.id}
                  className="bg-white border border-[#D9DEE5] hover:border-[#B2BDCE] active:border-[#98A2B3] active:bg-[#FAFAFA] active:translate-y-[0.5px] rounded-lg p-4 transition-all duration-150 flex flex-col sm:flex-row sm:items-start justify-between gap-4 group shadow-2xs hover:shadow-xs motion-reduce:transform-none"
                >
                  {/* Left Column: Filename, metadata, and status badges */}
                  <div className="flex-1 min-w-0 flex flex-col gap-2">
                    {/* Filename & Qualification Tag */}
                    <div className="flex items-start sm:items-center gap-2.5 flex-wrap">
                      <Link
                        href={`/documents/${doc.id}`}
                        className="text-[14.5px] font-bold text-[#111827] group-hover:text-[#3157D5] transition-colors truncate max-w-md md:max-w-xl cursor-pointer"
                        title={doc.original_filename}
                      >
                        {doc.original_filename}
                      </Link>

                      {/* Qualification Badge */}
                      {doc.qualification_status === 'AI_QUALIFIED' && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#ECFDF3] text-[#027A48] border border-[#ABEFC6]">
                          <Check className="w-3 h-3 mr-1" strokeWidth={2.5} />
                          <span>Qualified RFP</span>
                        </span>
                      )}
                      {isAmbiguous && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#FFFAEB] text-[#B54708] border border-[#FEDF89]">
                          <AlertTriangle className="w-3 h-3 mr-1" strokeWidth={2} />
                          <span>Ambiguous Tender</span>
                        </span>
                      )}
                      {isRejected && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#FEF3F2] text-[#B42318] border border-[#FECDCA]">
                          <Ban className="w-3 h-3 mr-1" strokeWidth={2} />
                          <span>Non-RFP Rejected</span>
                        </span>
                      )}
                      {doc.qualification_status === 'USER_CONFIRMED' && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#EFF8FF] text-[#175CD3] border border-[#B2DDFF]">
                          <CheckCircle className="w-3 h-3 mr-1" strokeWidth={2} />
                          <span>Manually Confirmed</span>
                        </span>
                      )}
                    </div>

                    {/* Metadata Line */}
                    <div className="flex items-center gap-2.5 text-[12px] text-[#667085] flex-wrap">
                      <span>{doc.total_pages > 0 ? `${doc.total_pages} pages` : 'Pending page audit'}</span>
                      <span className="w-1 h-1 rounded-full bg-[#98A2B3]" />
                      <span>{opStatus === 'UPLOAD_PENDING' ? 'Upload started' : 'Uploaded'} {formatTimeAgo(doc.created_at)}</span>
                      {opStatus === 'UPLOAD_PENDING' && <span className="text-[#B54708]">Upload pending · Select the same PDF in Upload Tender to recover</span>}

                      {/* Operational Status Tag */}
                      {isCompleted && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-[#98A2B3]" />
                          <span className="inline-flex items-center gap-1 font-semibold text-[#027A48]">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#12B76A]" />
                            Analysis Complete
                          </span>
                          <span className="w-1 h-1 rounded-full bg-[#98A2B3]" />
                          <span className="text-[#344054] font-medium bg-[#F5F6F4] px-1.5 py-0.5 rounded border border-[#E4E7EC]">
                            {doc.total_pages > 0
                              ? `${doc.evaluated_pages_count ?? doc.total_pages} / ${doc.total_pages} Pages Evaluated`
                              : 'Pages Evaluated'}
                          </span>
                        </>
                      )}

                      {isProcessing && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-[#98A2B3]" />
                          <span className="inline-flex items-center gap-1.5 font-semibold text-[#B54708]">
                            <span className="w-2 h-2 rounded-full bg-[#F79009] animate-pulse" />
                            {opStatus === 'EXTRACTING'
                              ? 'Extracting Document Pages...'
                              : opStatus === 'QUALIFYING'
                                ? 'Qualifying Document Signals...'
                                : 'Analysis In Progress...'}
                          </span>
                        </>
                      )}

                      {!isCompleted && !isProcessing && !isFailed && (opStatus === 'TEXT_EXTRACTED' || opStatus === 'UPLOADED') && !isRejected && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-[#98A2B3]" />
                          <span className="text-[#344054] font-medium bg-[#F5F6F4] px-1.5 py-0.5 rounded border border-[#E4E7EC]">
                            {opStatus === 'TEXT_EXTRACTED' ? 'Text Extracted' : 'Uploaded'}
                          </span>
                        </>
                      )}

                      {isFailed && (
                        <>
                          <span className="w-1 h-1 rounded-full bg-[#98A2B3]" />
                          <span className="inline-flex items-center gap-1 font-semibold text-[#D92D20]">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#F04438]" />
                            Analysis Failed
                          </span>
                          {doc.latest_run?.last_error && (
                            <span className="text-[#B42318] text-[11px] truncate max-w-xs" title={doc.latest_run.last_error}>
                              ({doc.latest_run.last_error})
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    {/* Document Summary & Recommended Action Box */}
                    {doc.qualification_reason && (
                      <div className="text-[12px] bg-[#F8F9FA] p-2.5 rounded border border-[#EAECF0] flex flex-col gap-1.5 mt-0.5">
                        <p className="text-[#344054] leading-relaxed">
                          <span className="font-semibold text-[#111827]">Document Summary: </span>
                          {doc.qualification_reason}
                        </p>
                        {doc.recommended_action && (
                          <div className="text-[11.5px] text-[#344054] flex items-start gap-1.5 border-t border-[#EAECF0] pt-1.5">
                            <span className="font-bold uppercase tracking-wider text-[10px] bg-[#EFF8FF] text-[#175CD3] px-1.5 py-0.5 rounded border border-[#B2DDFF] shrink-0">
                              Recommended Action
                            </span>
                            <span className="font-medium text-[#1D2939]">{doc.recommended_action}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Right Column: Clear Primary Action Button + Secondary Menu */}
                  <div className="shrink-0 sm:self-center flex items-center gap-2">
                    <Link
                      href={`/documents/${doc.id}`}
                      className={`w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-semibold rounded-md transition-all duration-150 ease-out cursor-pointer active:scale-[0.98] active:translate-y-px motion-reduce:transform-none ${isCompleted
                        ? 'bg-[#3157D5] hover:bg-[#2544ab] text-white shadow-2xs'
                        : isRejected
                          ? 'bg-[#FEF3F2] hover:bg-[#FEE4E2] text-[#B42318] border border-[#FECDCA]'
                          : isAmbiguous
                            ? 'bg-[#FFFAEB] hover:bg-[#FEF0C7] text-[#B54708] border border-[#FEDF89]'
                            : isFailed
                              ? 'bg-[#FEF3F2] hover:bg-[#FEE4E2] text-[#B42318] border border-[#FECDCA]'
                              : 'bg-white hover:bg-[#F5F6F4] text-[#344054] border border-[#D9DEE5]'
                        }`}
                    >
                      <span>
                        {isCompleted
                          ? 'Open Analysis'
                          : isRejected
                            ? 'Review Qualification'
                            : isAmbiguous
                              ? 'Review Intake'
                              : isFailed
                                ? 'View Error'
                                : 'View Status'}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5" strokeWidth={2} />
                    </Link>

                    {/* Direct Delete Button */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeletingDoc(doc);
                        setDeleteError(null);
                      }}
                      title="Delete document"
                      aria-label="Delete document"
                      className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-[12.5px] font-medium text-[#B42318] hover:text-[#912018] bg-white hover:bg-[#FEF3F2] border border-[#FECDCA] hover:border-[#FDA29B] rounded-md transition-all duration-150 ease-out cursor-pointer shrink-0 active:scale-[0.98] motion-reduce:transform-none"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-[#D92D20]" strokeWidth={1.75} />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </main>

      {/* 4. UPLOAD TENDER MODAL / INTAKE TRAY */}
      <AnimatePresence>
        {isUploadModalOpen && (
          <div
            className="fixed inset-0 z-50 overflow-y-auto p-4 sm:p-6 md:p-10 flex items-center justify-center"
            role="dialog"
            aria-modal="true"
          >
            <motion.div
              key="upload-modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="fixed inset-0 bg-black/50"
              onClick={() => setIsUploadModalOpen(false)}
            />
            <motion.div
              key="upload-modal-card"
              initial={{ opacity: 0, scale: 0.98, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 4 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 w-full max-w-2xl bg-white rounded-xl shadow-2xl overflow-hidden border border-[#D9DEE5]"
            >
              <div className="px-6 py-4 border-b border-[#D9DEE5] flex items-center justify-between bg-[#F8F9FA]">
                <div>
                  <h3 className="text-[15px] font-bold text-[#111827]">
                    Upload Tender for Review
                  </h3>
                  <p className="text-[12px] text-[#667085]">
                    Extract clauses, verify requirements, and evaluate bid coverage
                  </p>
                </div>
                <button
                  onClick={() => setIsUploadModalOpen(false)}
                  className="p-1.5 text-[#667085] hover:text-[#111827] hover:bg-gray-200 active:scale-[0.98] rounded transition-all duration-150 ease-out cursor-pointer motion-reduce:transform-none"
                  title="Close"
                >
                  <X className="w-4 h-4" strokeWidth={2} />
                </button>
              </div>

              <div className="p-6">
                <DocumentIntake
                  userId={userId}
                  onAnalysisComplete={handleUploadComplete}
                  onCancel={() => setIsUploadModalOpen(false)}
                />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 5. PERMANENT DELETE CONFIRMATION MODAL */}
      <AnimatePresence>
        {deletingDoc && (
          <div
            className="fixed inset-0 z-50 overflow-y-auto p-4 flex items-center justify-center"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
          >
            <motion.div
              key="delete-modal-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="fixed inset-0 bg-[#0F172A]/50 backdrop-blur-[2px]"
              onClick={() => {
                if (!isDeleting) {
                  setDeletingDoc(null);
                  setDeleteError(null);
                }
              }}
            />

            <motion.div
              key="delete-modal-card"
              initial={{ opacity: 0, scale: 0.98, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 4 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="relative z-10 w-full max-w-110 bg-white rounded-lg shadow-xl border border-[#E2E8F0] overflow-hidden"
            >
              {/* Header */}
              <div className="px-6 pt-6 pb-4 flex items-start justify-between">
                <div className="flex items-start gap-3.5">
                  <div className="w-10 h-10 rounded-full bg-[#FEF3F2] border border-[#FEE4E2] text-[#D92D20] flex items-center justify-center shrink-0">
                    <Trash2 className="w-5 h-5 text-[#D92D20]" strokeWidth={1.75} />
                  </div>
                  <div>
                    <h3 id="delete-dialog-title" className="text-[16px] font-semibold text-[#101828] leading-tight">
                      Delete tender document
                    </h3>
                    <p className="text-[13px] text-[#475467] mt-1 leading-normal">
                      This will permanently remove this tender and all its associated intelligence.
                    </p>
                  </div>
                </div>
                <button
                  disabled={isDeleting}
                  onClick={() => {
                    setDeletingDoc(null);
                    setDeleteError(null);
                  }}
                  className="p-1 text-[#98A2B3] hover:text-[#475467] hover:bg-[#F2F4F7] active:scale-[0.98] rounded-md transition-all duration-150 ease-out cursor-pointer disabled:opacity-50 -mr-1 -mt-1 motion-reduce:transform-none"
                  title="Close"
                >
                  <X className="w-4 h-4" strokeWidth={2} />
                </button>
              </div>

              {/* Document Details Card */}
              <div className="px-6 pb-5 space-y-3.5">
                <div className="p-3 bg-[#F8FAFC] border border-[#E2E8F0] rounded-md">
                  <div className="flex items-center gap-2.5">
                    <FileText className="w-4 h-4 text-[#64748B] shrink-0" strokeWidth={2} />
                    <span className="text-[13px] font-medium text-[#1E293B] truncate" title={deletingDoc.original_filename}>
                      {deletingDoc.original_filename}
                    </span>
                  </div>
                  <div className="mt-2 pt-2 border-t border-[#EDF2F7] flex items-center gap-3 text-[11.5px] text-[#64748B]">
                    <span>{deletingDoc.total_pages} pages</span>
                    <span className="w-1 h-1 rounded-full bg-[#98A2B3]" />
                    <span>{(deletingDoc.size_bytes / 1024 / 1024).toFixed(1)} MB</span>
                    <span className="w-1 h-1 rounded-full bg-[#98A2B3]" />
                    <span className="capitalize">{deletingDoc.status.replace(/_/g, ' ').toLowerCase()}</span>
                  </div>
                </div>

                {/* Items affected breakdown */}
                <div className="rounded-md border border-[#F2F4F7] bg-[#FAFAFA] p-3 space-y-2">
                  <p className="text-[11px] font-semibold text-[#64748B] uppercase tracking-wider">
                    The following data will be purged:
                  </p>
                  <div className="grid grid-cols-2 gap-2 text-[12px] text-[#475467]">
                    <div className="flex items-center gap-1.5">
                      <HardDrive className="w-3.5 h-3.5 text-[#98A2B3] shrink-0" strokeWidth={2} />
                      <span>Raw PDF file</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <FileCheck className="w-3.5 h-3.5 text-[#98A2B3] shrink-0" strokeWidth={2} />
                      <span>Extracted pages</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Database className="w-3.5 h-3.5 text-[#98A2B3] shrink-0" strokeWidth={2} />
                      <span>Clause findings</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <ShieldAlert className="w-3.5 h-3.5 text-[#98A2B3] shrink-0" strokeWidth={2} />
                      <span>Risk matrix audit</span>
                    </div>
                  </div>
                </div>

                {/* Notice */}
                <p className="text-[12px] text-[#B42318] bg-[#FEF3F2] border border-[#FECDCA] rounded-md px-3 py-2 leading-snug">
                  <strong>Warning:</strong> This operation is permanent and cannot be reversed.
                </p>

                {/* Error if deletion failed */}
                {deleteError && (
                  <div className="p-3 bg-[#FEF3F2] border border-[#FECDCA] rounded-md text-[#B42318] text-[12px] flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-[#D92D20] shrink-0 mt-0.5" strokeWidth={2} />
                    <span className="leading-normal">{deleteError}</span>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-6 py-3.5 bg-[#F8FAFC] border-t border-[#E2E8F0] flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={() => {
                    setDeletingDoc(null);
                    setDeleteError(null);
                  }}
                  className="px-3.5 py-2 text-[13px] font-medium text-[#344054] bg-white hover:bg-[#F2F4F7] active:scale-[0.98] border border-[#D0D5DD] rounded-md transition-all duration-150 ease-out cursor-pointer disabled:opacity-50 motion-reduce:transform-none"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isDeleting}
                  onClick={handleDeleteConfirm}
                  className="px-4 py-2 text-[13px] font-medium text-white bg-[#D92D20] hover:bg-[#B42318] active:scale-[0.98] active:translate-y-px rounded-md transition-all duration-150 ease-out cursor-pointer shadow-xs disabled:opacity-50 flex items-center gap-2 motion-reduce:transform-none"
                >
                  {isDeleting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-white" strokeWidth={2} />
                      <span>Deleting...</span>
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-3.5 h-3.5 text-white" strokeWidth={2} />
                      <span>Delete tender</span>
                    </>
                  )}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
