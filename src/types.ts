// Domain types for the rack BOM review. All demo data is synthetic.

export type ApprovedSubstitute = {
  partNumber: string;
  manufacturer: string;
  revision: string;
};

export type SpecPart = {
  partNumber: string;
  description: string;
  revision: string;
  qtyPerRack: number;
  wattsEach: number;
  approvedManufacturers: string[];
  approvedSubstitutes: ApprovedSubstitute[];
};

export type Spec = {
  specId: string;
  revision: string;
  rackName: string;
  powerBudgetW: number;
  parts: SpecPart[];
};

export type BomLine = {
  line: number;
  partNumber: string;
  description: string;
  manufacturer: string;
  quantity: number;
  revision: string;
  leadTimeDays: number | null;
  certRef: string;
};

export type Cert = {
  certRef: string;
  partNumber: string;
  drawingRevision: string;
  issued: string;
};

export type BuildContext = {
  buildId: string;
  odm: string;
  specRevision: string;
  /** ISO date the parts must be on site. */
  needBy: string;
  /** ISO date the review is run "as of"; makes lead-time checks reproducible. */
  asOf: string;
};

export type ReviewInput = {
  spec: Spec;
  bom: BomLine[];
  certs: Cert[];
  context: BuildContext;
};

export type Category =
  | "substitution"
  | "missing-data"
  | "revision-mismatch"
  | "quantity"
  | "lead-time"
  | "power"
  | "cert"
  | "vendor"
  | "not-in-spec";

export type Severity = "blocker" | "needs-review" | "info";

export type FindingStatus = "pending" | "approved" | "rejected";

export type Finding = {
  id: string;
  /** BOM line number, or null for rack-level findings (power, missing parts). */
  line: number | null;
  partNumber: string;
  category: Category;
  severity: Severity;
  expected: string;
  found: string;
  evidence: string;
  suggestedAction: string;
  source: "rule" | "llm";
  /** Model that produced an llm finding. */
  modelId?: string;
  status: FindingStatus;
  reviewerNote?: string;
};

export type Verdict = "ready" | "hold";

export type ReviewStatus =
  | "idle"
  | "running"
  | "awaiting-approval"
  | "drafting"
  | "complete"
  | "rejected"
  | "error";

export type AuditEntry = {
  at: string;
  actor: "system" | "reviewer";
  action: string;
  detail?: string;
};

export type UsageSource = "chat" | "judge" | "draft";

export type UsageRecord = {
  at: string;
  source: UsageSource;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  estCostUsd: number;
  ms: number;
};

export type EscalationNote = {
  subject: string;
  body: string;
  modelId: string;
  /** "template" when the model failed and the code-built note was used. */
  source: "llm" | "template";
  createdAt: string;
};

export type ReviewState = {
  context: BuildContext | null;
  specId: string | null;
  /** Submitted BOM, kept so chat can quote exact lines. */
  bom: BomLine[];
  status: ReviewStatus;
  verdict: Verdict | null;
  findings: Finding[];
  workflowId: string | null;
  modelId: string;
  note: EscalationNote | null;
  audit: AuditEntry[];
  usage: UsageRecord[];
  error: string | null;
};

export type FindingDecision = {
  id: string;
  status: "approved" | "rejected";
  severity?: Severity;
  suggestedAction?: string;
  reviewerNote?: string;
};
