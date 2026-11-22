export interface FlightAction {
  type: string;
  target?: string;
  value?: string;
  success: boolean;
  error?: string;
}

export interface FlightDiffSummary {
  addedNodes: number;
  removedNodes: number;
  urlChanged: boolean;
  titleChanged: boolean;
}

export interface FlightConsoleEntry {
  type: string;
  text: string;
  timestamp?: number;
}

export interface FlightStep {
  index: number;
  timestamp: number;
  elapsedMs: number;
  url: string;
  title: string;
  action?: FlightAction;
  actionMapText?: string;
  markdownPreview?: string;
  diffSummary?: FlightDiffSummary;
  consoleLogs?: FlightConsoleEntry[];
}

export interface FlightSession {
  id: string;
  name?: string;
  startedAt: string;
  endedAt?: string;
  totalDurationMs?: number;
  initialUrl: string;
  steps: FlightStep[];
}
