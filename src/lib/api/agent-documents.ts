import { invoke } from "@tauri-apps/api/core";

export interface DocumentCell {
  reference: string;
  value: string;
  formula?: string;
}
export interface DocumentSection {
  id: string;
  label: string;
  text: string;
  rows: DocumentCell[][];
}
export interface AgentDocument {
  path: string;
  name: string;
  kind: "docx" | "xlsx" | "pptx" | "pdf";
  bytes: number;
  revision: string;
  sections: DocumentSection[];
  warnings: string[];
}
export interface DocumentView {
  path: string;
  revision: string;
  locator?: string | null;
  selection?: string | null;
  updatedAt: number;
}
export interface DocumentSearch {
  path: string;
  revision: string;
  matches: { locator: string; label: string; text: string }[];
  truncated: boolean;
}

const call = <T>(sessionId: string, method: string, args: unknown) =>
  invoke<T>("invoke_agent_document", { sessionId, method, args });

export const agentDocumentsApi = {
  open: (sessionId: string, path: string) =>
    call<AgentDocument>(sessionId, "open", { path }),
  read: (sessionId: string, path: string, offset = 0, limit = 100) =>
    call<AgentDocument>(sessionId, "read", { path, offset, limit }),
  search: (sessionId: string, path: string, query: string) =>
    call<DocumentSearch>(sessionId, "search", { path, query }),
  report: (
    sessionId: string,
    path: string,
    locator?: string,
    selection?: string,
    expectedRevision?: string,
  ) =>
    call<DocumentView>(sessionId, "report", {
      path,
      locator,
      selection,
      expectedRevision,
    }),
  pdf: (sessionId: string, path: string, expectedRevision: string) =>
    call<string>(sessionId, "pdf", { path, expectedRevision }),
};

export const isOfficeDocumentPath = (path: string) =>
  /(?:^|[\\/])[^\\/]*\.(?:docx|xlsx|pptx|pdf)(?:#[^\\/]*)?$/i.test(path);
