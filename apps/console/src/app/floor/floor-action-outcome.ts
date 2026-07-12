export interface FloorActionOutcome {
  kind: 'conflict' | 'error';
  message: string;
}
