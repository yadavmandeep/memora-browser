import { BlackboardFact, TabSummary, BlackboardState } from './types.js';

/**
 * Agent Blackboard: Cross-Tab Shared Working Memory & Context Graph.
 * Allows multi-tab autonomous agents to store, cross-reference, and summarize
 * findings across multiple web pages (e.g. Tab 1: docs, Tab 2: app form, Tab 3: search)
 * in an ultra-compact (~150 token) representation without overflowing LLM context.
 */
export class AgentBlackboard {
  private sessionId: string;
  private variables = new Map<string, any>();
  private facts: BlackboardFact[] = [];
  private tabs = new Map<string, TabSummary>();
  private activeTabId: string | null = null;

  constructor(sessionId: string = `bb-${Date.now()}`) {
    this.sessionId = sessionId;
  }

  // --- Key-Value Variables ---
  public set(key: string, value: any): void {
    this.variables.set(key, value);
  }

  public get<T = any>(key: string): T | undefined {
    return this.variables.get(key);
  }

  public has(key: string): boolean {
    return this.variables.has(key);
  }

  public delete(key: string): boolean {
    return this.variables.delete(key);
  }

  // --- Working Memory Facts ---
  public recordFact(fact: string, category: string = 'general', sourceTabId?: string): BlackboardFact {
    const entry: BlackboardFact = {
      id: `fact-${this.facts.length + 1}`,
      category,
      fact: fact.trim(),
      sourceTabId: sourceTabId || this.activeTabId || undefined,
      timestamp: Date.now()
    };
    this.facts.push(entry);
    return entry;
  }

  public listFacts(category?: string): BlackboardFact[] {
    if (!category) return [...this.facts];
    return this.facts.filter((f) => f.category.toLowerCase() === category.toLowerCase());
  }

  // --- Multi-Tab Tracking ---
  public registerTab(tab: TabSummary): void {
    this.tabs.set(tab.id, tab);
    if (tab.active || !this.activeTabId) {
      this.activeTabId = tab.id;
    }
  }

  public updateTab(id: string, updates: Partial<TabSummary>): void {
    const existing = this.tabs.get(id);
    if (existing) {
      Object.assign(existing, updates);
    }
  }

  public removeTab(id: string): boolean {
    if (this.activeTabId === id) this.activeTabId = null;
    return this.tabs.delete(id);
  }

  public listTabs(): TabSummary[] {
    return Array.from(this.tabs.values()).map(t => ({
      ...t,
      active: t.id === this.activeTabId
    }));
  }

  public setActiveTab(id: string): boolean {
    if (!this.tabs.has(id)) return false;
    this.activeTabId = id;
    return true;
  }

  // --- Compact Markdown Export for LLM Prompt Context ---
  public getSharedContextMarkdown(): string {
    const sections: string[] = ['### Multi-Tab Working Memory & Blackboard:'];

    // 1. Open Tabs Summary
    if (this.tabs.size > 0) {
      sections.push('**Open Tabs:**');
      for (const tab of this.tabs.values()) {
        const activeMarker = tab.id === this.activeTabId ? ' *(Active)*' : '';
        sections.push(`- [Tab: ${tab.id}] "${tab.title}" -> ${tab.url}${activeMarker}`);
      }
    }

    // 2. Cross-Tab Variables
    if (this.variables.size > 0) {
      sections.push('**Variables Stored:**');
      for (const [k, v] of this.variables.entries()) {
        const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        sections.push(`- \`${k}\`: ${valStr}`);
      }
    }

    // 3. Recorded Facts
    if (this.facts.length > 0) {
      sections.push('**Key Cross-Tab Findings:**');
      for (const f of this.facts.slice(-10)) {
        const cat = f.category !== 'general' ? `[${f.category}] ` : '';
        sections.push(`- ${cat}${f.fact}`);
      }
    }

    if (sections.length === 1) {
      return '(Blackboard is empty)';
    }

    return sections.join('\n');
  }

  public exportState(): BlackboardState {
    return {
      sessionId: this.sessionId,
      variables: Object.fromEntries(this.variables.entries()),
      facts: [...this.facts],
      tabs: this.listTabs()
    };
  }

  public clear(): void {
    this.variables.clear();
    this.facts = [];
    this.tabs.clear();
    this.activeTabId = null;
  }
}
