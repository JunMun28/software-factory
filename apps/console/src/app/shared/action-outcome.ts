export interface FloorActionOutcome {
  kind: 'conflict' | 'error';
  message: string;
}

export type FloorActionVerb =
  | 'approve'
  | 'send back'
  | 'retry'
  | 'take over'
  | 'send back to stage'
  | 'send to agent'
  | 'cancel'
  | 'steer';

export interface FloorActionError {
  status?: number;
  error?: Partial<ConflictPayload>;
}

/** One conflict/error vocabulary for every Floor-family request action. */
export function floorActionOutcome(
  verb: FloorActionVerb,
  error: FloorActionError,
): FloorActionOutcome {
  const conflict = error.status === 409 ? error.error : null;
  if (conflict?.acted_by && conflict.acted_at) {
    const at = new Date(conflict.acted_at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    return {
      kind: 'conflict',
      message: `Already ${PAST_TENSE[verb]} by ${conflict.acted_by} at ${at}`,
    };
  }
  if (error.status === 409 && verb === 'steer')
    return { kind: 'conflict', message: 'Run is no longer in flight — it reached a gate.' };
  return { kind: 'error', message: `Couldn’t ${verb}. Try again.` };
}

const PAST_TENSE: Record<FloorActionVerb, string> = {
  approve: 'approved',
  'send back': 'sent back',
  retry: 'retried',
  'take over': 'taken over',
  'send back to stage': 'sent back to stage',
  'send to agent': 'sent to the agent',
  cancel: 'cancelled',
  steer: 'steered',
};

interface ConflictPayload {
  detail: string;
  acted_by: string;
  acted_at: string;
  resulting_state: string;
}
