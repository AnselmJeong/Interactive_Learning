export type ProjectTransferCounts = {
  sources: number;
  materials: number;
  sessions: number;
  messages: number;
  annotations: number;
  preparedMessages: number;
};

export type ProjectTransferManifest = {
  format: "learnie-project-transfer";
  schemaVersion: number;
  minimumReaderSchemaVersion: number;
  appVersion: string;
  projectId: string;
  projectTitle: string;
  exportId: string;
  parentExportId: string | null;
  deviceId: string;
  exportedAt: string;
  projectStateHash: string;
  counts: ProjectTransferCounts;
  files: Array<{ path: string; size: number; sha256: string }>;
};

export type ProjectTransferClassification =
  | "create_new"
  | "fast_forward"
  | "no_changes"
  | "diverged"
  | "unrelated_or_legacy"
  | "invalid";

export type ProjectTransferPreview = {
  importId: string;
  fileName: string;
  projectId: string;
  projectTitle: string;
  exportedAt: string;
  sourceDeviceLabel: string;
  classification: ProjectTransferClassification;
  counts: ProjectTransferCounts;
  changes: { added: number; updated: number; unchanged: number; conflicted: number };
  warnings: string[];
};

export type ProjectTransferExport = {
  zipPath: string;
  fileName: string;
  projectId: string;
  exportId: string;
  counts: ProjectTransferCounts;
};

export type ProjectTransferImportResult = {
  projectId: string;
  classification: "create_new" | "fast_forward" | "no_changes";
  imported: boolean;
};

export type SessionReadableExport = {
  zipPath: string;
  fileName: string;
  sessionId: string;
  messageCount: number;
  annotationCount: number;
  assetCount: number;
};
