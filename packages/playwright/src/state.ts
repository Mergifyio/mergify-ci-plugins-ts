import { readFileSync, writeFileSync } from 'node:fs';

export interface MergifyState {
  quarantineList: string[];
  retryCounts: Record<string, number>;
  maxRetries: number;
  flakyMode?: 'new' | 'unhealthy';
  existingTestNames?: string[];
}

export function writeState(path: string, state: MergifyState): void {
  writeFileSync(path, JSON.stringify(state), 'utf-8');
}

export function readState(path: string): MergifyState | null {
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as MergifyState;
  } catch {
    return null;
  }
}
