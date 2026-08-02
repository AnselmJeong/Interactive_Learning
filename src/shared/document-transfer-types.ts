export type DocumentTransferCounts = {
  sources: number;
  materials: number;
  sessions: number;
  messages: number;
  preparedMessages: number;
  annotations: number;
  assets: number;
  crossDocumentMaterials: number;
};

export type DocumentTransferClassification =
  | "ready"
  | "cross_document_blocked"
  | "create_document"
  | "no_changes"
  | "diverged"
  | "invalid";

export type DocumentTransferPreview = {
  documentId: string;
  documentTitle: string;
  documentType: "book" | "article";
  classification: DocumentTransferClassification;
  counts: DocumentTransferCounts;
  warnings: string[];
};

export type DocumentTransferExport = DocumentTransferPreview & {
  zipPath: string;
  fileName: string;
  exportId: string;
  validated: true;
};

export type DocumentTransferManifest = {
  format: "learnie-document-transfer";
  schemaVersion: 1;
  minimumReaderSchemaVersion: 1;
  exportId: string;
  parentExportId: string | null;
  deviceId: string;
  originProjectId: string;
  originDocumentId: string;
  documentTitle: string;
  documentType: "book" | "article";
  exportedAt: string;
  documentStateHash: string;
  counts: DocumentTransferCounts;
  files: Array<{ path: string; size: number; sha256: string }>;
};

export type DocumentTransferImportPreview = {
  importId: string;
  fileName: string;
  destinationProjectId: string;
  documentTitle: string;
  documentType: "book" | "article";
  exportedAt: string;
  classification: "create_document" | "no_changes" | "diverged" | "invalid";
  counts: DocumentTransferCounts;
  warnings: string[];
};

export type DocumentTransferImportResult = {
  projectId: string;
  documentId: string | null;
  classification: "create_document" | "no_changes";
  imported: boolean;
};
