/**
 * Shared vocabulary: phases, outcomes, and the settings shape.
 *
 * Kept free of host imports so both the coordinator and the browser half can
 * describe the same lifecycle without pulling a Node module into the bundle.
 */

/** The lifecycle of one handoff or compaction attempt. */
export type Phase =
  | 'idle'
  | 'preparing'
  | 'waiting-for-step-boundary'
  | 'summarizing'
  | 'creating-session'
  | 'transferring'
  | 'waiting-for-compact'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Why an automatic action was proposed. */
export type ActionReason = 'manual' | 'context' | 'cumulative'

/** Which automatic action a proposal asks the coordinator to run. */
export type ActionKind = 'handoff' | 'compact'

/** How trustworthy a measurement is. */
export type MeasureQuality = 'exact' | 'estimated' | 'unavailable'

/** Which metric the user asked automatic handoff to key on. */
export type TriggerMode = 'context' | 'cumulative' | 'either'

/** One inherited configuration item and its outcome. */
export interface InheritOutcome {
  readonly item: string
  readonly status: 'inherited' | 'fallback' | 'skipped'
  readonly detail?: string
}

/** The verdict of one attempt. */
export interface ActionResult {
  readonly ok: boolean
  readonly phase: Phase
  readonly text: string
  readonly newSessionId?: string
  readonly inherited?: readonly InheritOutcome[]
  readonly warnings?: readonly string[]
  readonly error?: string
}

/**
 * What the document step hands the coordinator.
 *
 * `brief` is the only field the coordinator needs — it is the string delivered
 * to the successor session. With the document design that string is a short
 * pointer, not the content, but keeping the name means the delivery path, the
 * reroute path and their tests are unchanged.
 *
 * The rest is reporting: which file was written, how large it is, which
 * sections the budget dropped, and what the archive did. They are optional so a
 * test fixture need only supply a string, and so a deployment with no writable
 * workspace can still deliver a message-only handoff.
 */
export interface HandoffArtifact {
  readonly brief: string
  readonly redactions: readonly string[]
  /** Workspace-relative path of the document, when one was written. */
  readonly documentPath?: string
  /** Size of the document on disk, in bytes. */
  readonly bytes?: number
  /** Sections removed to stay inside the character budget. */
  readonly dropped?: readonly string[]
  /** Outcome of moving the previous document into CHANGELOG / history. */
  readonly archive?: {
    readonly archived: boolean
    readonly changelogUpdated: boolean
    readonly historyUpdated: boolean
    readonly skippedDuplicate: boolean
    readonly warnings: readonly string[]
  }
}

/** A failure retained for `/handoff status`. */
export interface FailureRecord {
  readonly at: number
  readonly phase: Phase
  readonly message: string
}
