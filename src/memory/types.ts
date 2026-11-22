export interface BlackboardFact {
  id: string;
  category: string;
  fact: string;
  sourceTabId?: string;
  timestamp: number;
}

export interface TabSummary {
  id: string;
  url: string;
  title: string;
  active: boolean;
  interactiveCount?: number;
}

export interface BlackboardState {
  sessionId: string;
  variables: Record<string, any>;
  facts: BlackboardFact[];
  tabs: TabSummary[];
}
