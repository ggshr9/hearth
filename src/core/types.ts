// hearth core types — see docs/SPEC.md §2 + §5
//
// ChangePlan is the unit of vault mutation: the agent (or an extractor)
// produces a plan, the kernel applies it after permission and precondition
// checks. The agent never writes directly.

export type Risk = 'low' | 'medium' | 'high';

export interface AnchorLine {
  type: 'line';
  line_start: number;
  line_end: number;
  quote: string;
  quote_hash: string;
}

export interface AnchorPage {
  type: 'page';
  page: number;
  quote?: string;
  quote_hash?: string;
}

export interface AnchorTimestamp {
  type: 'timestamp';
  timestamp: string;
  quote?: string;
}

export interface AnchorCss {
  type: 'css';
  selector: string;
  quote: string;
  quote_hash: string;
}

export type Anchor = AnchorLine | AnchorPage | AnchorTimestamp | AnchorCss;

export interface Claim {
  text: string;
  source: string;
  anchor: Anchor;
  confidence: 'high' | 'medium' | 'low';
}

export interface Precondition {
  /** True iff the target path must already exist. */
  exists: boolean;
  /** Required when exists=true: sha256 of the target file at plan-time.
   *  Apply rejects if the file's current hash differs. */
  base_hash?: string;
}

export interface PatchReplace {
  type: 'replace';
  /** Full new file content. */
  value: string;
}

export interface PatchUnifiedDiff {
  type: 'unified_diff';
  /** A unified diff payload. v0.1 parses but does not apply this. */
  value: string;
}

export type Patch = PatchReplace | PatchUnifiedDiff;

export type ChangeOpKind = 'create' | 'update' | 'delete';

export interface ChangeOp {
  op: ChangeOpKind;
  path: string;
  reason: string;
  precondition: Precondition;
  /** create / update: the new contents. delete: omit. */
  patch?: Patch;
  body_preview?: string;
}

export interface ChangePlan {
  change_id: string;
  source_id: string;
  risk: Risk;
  ops: ChangeOp[];
  requires_review: boolean;
  /** ISO 8601. */
  created_at: string;
  /** Free-form note from the agent. */
  note?: string;
}

export interface AppliedOpResult {
  op: ChangeOpKind;
  path: string;
  ok: boolean;
  error?: string;
}

export interface AppliedResult {
  change_id: string;
  ok: boolean;
  ops: AppliedOpResult[];
  /** Set when ok=false: human-readable summary. */
  error?: string;
}
