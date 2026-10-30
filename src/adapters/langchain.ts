import { MemoraAgent } from './agent.js';

export interface LangChainToolLike {
  name: string;
  description: string;
  invoke: (input: any) => Promise<string>;
  call?: (input: any) => Promise<string>;
}

/**
 * Creates a suite of LangChain-compatible tools powered by Memora Browser.
 * These tools allow LangChain agents to browse, click, type, diff, and fill forms
 * with 95% token savings compared to raw HTML or screenshots.
 */
export function createMemoraLangChainTools(agent: MemoraAgent): LangChainToolLike[] {
  const tools: LangChainToolLike[] = [
    {
      name: 'memora_navigate',
      description: 'Navigates to a URL and returns token-condensed Markdown and indexed interactive action map (@1, @2, ...). Input: { "url": "https://example.com" } or url string.',
      invoke: async (input: any) => {
        const url = typeof input === 'string' ? input : input.url;
        const snap = await agent.goto(url);
        return `Successfully navigated to: ${snap.title} (${snap.url})\n\n${snap.actionMapText}\n\n=== PAGE CONTENT ===\n${snap.markdown.slice(0, 4000)}`;
      }
    },
    {
      name: 'memora_snapshot',
      description: 'Returns the current page action map (@1, @2) and content without navigating. Input: optional focus/exclude options.',
      invoke: async (input: any = {}) => {
        const snap = agent.snapshot({
          focusSelector: input?.focusSelector,
          excludeSelectors: input?.excludeSelectors
        });
        return `${snap.actionMapText}\n\n=== PAGE CONTENT ===\n${snap.markdown.slice(0, 4000)}`;
      }
    },
    {
      name: 'memora_act',
      description: 'Clicks or types into an interactive element using its action ID (e.g. "@1", "@2"). Input: { "actionId": "@1", "text": "optional text to type" }',
      invoke: async (input: any) => {
        const actionId = typeof input === 'string' ? input : input.actionId;
        const text = typeof input === 'object' ? input.text : undefined;
        const success = agent.act(actionId, text);
        const diff = agent.diff();
        return `Action ${actionId} ${success ? 'succeeded' : 'failed'}.\n\nPage changes:\n${diff.summary}`;
      }
    },
    {
      name: 'memora_diff',
      description: 'Compares current page state with the previous state to see what DOM elements appeared, disappeared, or changed. Input: empty object {}.',
      invoke: async () => {
        const diff = agent.diff();
        return `STATE DIFF:\nAdded: ${diff.addedActions.length}, Removed: ${diff.removedActions.length}, Changed: ${diff.mutatedActions.length}\n\nSummary:\n${diff.summary}`;
      }
    },
    {
      name: 'memora_fill_form',
      description: 'Fills multiple form fields simultaneously and optionally submits the form in one atomic turn. Input: { "fields": { "@1": "user@test.com", "@2": "password" }, "submit": true }',
      invoke: async (input: any) => {
        const fields = input.fields || {};
        const submit = input.submit ?? true;
        const res = await agent.fillForm(fields, submit);
        const snap = agent.snapshot();
        return `Form filled: ${res.fieldsFilled} fields. Submitted: ${res.submitted}.\nCurrent URL: ${res.url}\n\n${snap.actionMapText}`;
      }
    }
  ];

  // Add .call alias for backward compatibility with older LangChain versions
  for (const tool of tools) {
    tool.call = tool.invoke;
  }

  return tools;
}
