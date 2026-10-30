import { InteractiveElement, PageDiff, SemanticPageSnapshot } from '../types/index.js';

export function computePageDiff(
  prev: SemanticPageSnapshot | null | undefined,
  curr: SemanticPageSnapshot
): PageDiff {
  if (!prev) {
    return {
      urlChanged: true,
      previousUrl: '',
      currentUrl: curr.url,
      titleChanged: true,
      previousTitle: '',
      currentTitle: curr.title,
      addedActions: [...curr.actions],
      removedActions: [],
      mutatedActions: [],
      summary: `Initial page load: "${curr.title}" at ${curr.url} with ${curr.interactiveCount} interactive elements.`
    };
  }

  const urlChanged = prev.url !== curr.url;
  const titleChanged = prev.title !== curr.title;

  const prevBySelector = new Map<string, InteractiveElement>();
  for (const act of prev.actions) {
    prevBySelector.set(act.selector, act);
  }

  const currBySelector = new Map<string, InteractiveElement>();
  for (const act of curr.actions) {
    currBySelector.set(act.selector, act);
  }

  const addedActions: InteractiveElement[] = [];
  const mutatedActions: PageDiff['mutatedActions'] = [];

  for (const act of curr.actions) {
    const old = prevBySelector.get(act.selector);
    if (!old) {
      addedActions.push(act);
    } else {
      const changes: Record<string, { from: any; to: any }> = {};

      if (old.text !== act.text) {
        changes.text = { from: old.text, to: act.text };
      }
      if (old.value !== act.value) {
        changes.value = { from: old.value, to: act.value };
      }
      if (old.disabled !== act.disabled) {
        changes.disabled = { from: old.disabled, to: act.disabled };
      }
      if (old.checked !== act.checked) {
        changes.checked = { from: old.checked, to: act.checked };
      }
      if (old.expanded !== act.expanded) {
        changes.expanded = { from: old.expanded, to: act.expanded };
      }
      if (old.selected !== act.selected) {
        changes.selected = { from: old.selected, to: act.selected };
      }

      if (Object.keys(changes).length > 0) {
        mutatedActions.push({
          actionId: act.actionId,
          selector: act.selector,
          role: act.role,
          text: act.text,
          changes
        });
      }
    }
  }

  const removedActions: InteractiveElement[] = [];
  for (const act of prev.actions) {
    if (!currBySelector.has(act.selector)) {
      removedActions.push(act);
    }
  }

  // Build clean LLM summary
  const summaryLines: string[] = ['=== PAGE STATE DELTA ==='];

  if (urlChanged) {
    summaryLines.push(`URL navigated: "${prev.url}" -> "${curr.url}"`);
  }
  if (titleChanged) {
    summaryLines.push(`Title changed: "${prev.title}" -> "${curr.title}"`);
  }

  if (addedActions.length > 0) {
    summaryLines.push(`\nAdded (${addedActions.length} elements):`);
    for (const a of addedActions) {
      summaryLines.push(`  + [${a.actionId}] [${a.role}] "${a.text}" (selector: ${a.selector})`);
    }
  }

  if (removedActions.length > 0) {
    summaryLines.push(`\nRemoved (${removedActions.length} elements):`);
    for (const a of removedActions) {
      summaryLines.push(`  - [${a.actionId}] [${a.role}] "${a.text}" (selector: ${a.selector})`);
    }
  }

  if (mutatedActions.length > 0) {
    summaryLines.push(`\nMutated (${mutatedActions.length} elements):`);
    for (const m of mutatedActions) {
      const details = Object.entries(m.changes)
        .map(([k, v]) => `${k}: ${JSON.stringify(v.from)} -> ${JSON.stringify(v.to)}`)
        .join(', ');
      summaryLines.push(`  * [${m.actionId}] [${m.role}] "${m.text}" (${details})`);
    }
  }

  if (!urlChanged && !titleChanged && addedActions.length === 0 && removedActions.length === 0 && mutatedActions.length === 0) {
    summaryLines.push('No visual, DOM, or interactive changes detected.');
  }

  return {
    urlChanged,
    previousUrl: prev.url,
    currentUrl: curr.url,
    titleChanged,
    previousTitle: prev.title,
    currentTitle: curr.title,
    addedActions,
    removedActions,
    mutatedActions,
    summary: summaryLines.join('\n')
  };
}

