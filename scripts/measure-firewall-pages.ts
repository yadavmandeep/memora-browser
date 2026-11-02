/**
 * Loads real public pages with the MCP server (firewall off), then applies the firewall's content step
 * to the exact tool output to measure: findings / redactions on ordinary pages (false positives), the
 * size the wrapper adds, and the time the content step (text + hidden-HTML scan) takes.
 *
 *   npx tsx scripts/measure-firewall-pages.ts [url ...]
 */

import { MCPServer } from '../src/mcp/server.js';
import { PromptFirewall } from '../src/firewall/firewall.js';

const GENERAL = [
  'https://example.com/',
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://en.wikipedia.org/wiki/India',
  'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch',
  'https://docs.python.org/3/tutorial/introduction.html',
  'https://nodejs.org/api/http.html',
  'https://react.dev/learn',
  'https://docs.stripe.com/api/authentication',
  'https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api',
  'https://news.ycombinator.com/',
  'https://www.bbc.com/news',
  'https://www.npmjs.com/package/express',
  'https://github.com/microsoft/playwright',
  'https://stackoverflow.com/questions/111102/how-do-javascript-closures-work',
  'https://www.gnu.org/licenses/gpl-3.0.en.html',
  'https://www.rfc-editor.org/rfc/rfc9309.html',
  'https://www.w3.org/TR/WCAG21/',
  'https://www.theverge.com/',
  'https://learn.microsoft.com/en-us/azure/ai-services/openai/overview',
  'https://httpbin.org/html',
];
// Pages *about* prompt injection / prompting: they quote attack phrases on purpose
const AI_SECURITY = [
  'https://en.wikipedia.org/wiki/Prompt_injection',
  'https://owasp.org/www-project-top-10-for-large-language-model-applications/',
  'https://genai.owasp.org/llmrisk/llm01-prompt-injection/',
  'https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview',
  'https://simonwillison.net/2022/Sep/12/prompt-injection/',
];

const argUrls = process.argv.slice(2);
const sets: Array<[string, string[]]> = argUrls.length ? [['custom', argUrls]] : [['general', GENERAL], ['ai-security', AI_SECURITY]];
const fw = new PromptFirewall({ preset: 'standard' });

for (const [name, urls] of sets) {
  console.log(`\n=== ${name}`);
  let loaded = 0, flagged = 0, redactedPages = 0, extraChars = 0, baseChars = 0;
  const times: number[] = [];
  for (const url of urls) {
    const mcp = new MCPServer({}, 'native');
    try {
      // Hard limit per page: a hung page script must not stall the whole run
      const text: string = await Promise.race([
        (mcp as any).executeTool('memora_browse', { url, timeout: 20000 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('TIMEOUT after 45s (engine did not return)')), 45000)),
      ]);
      const html: string = await (mcp as any).engine.html();
      const t0 = performance.now();
      // Same split as MCPServer.callTool: the server's handoff hint is not page content
      const NL = String.fromCharCode(10);
      const hint = text.split(NL).find((l) => l.startsWith('A person can complete it'));
      const out = fw.processContent(hint ? text.replace(NL + hint, '') : text, { source: url, html });
      if (hint) out.text += NL + hint;
      const ms = performance.now() - t0;
      const challenged = /^# CHALLENGE DETECTED/.test(text);
      loaded++;
      times.push(ms);
      baseChars += text.length;
      extraChars += out.text.length - text.length;
      if (out.findings.length) flagged++;
      if (out.redacted) redactedPages++;
      const rules = [...new Set(out.findings.map((f) => `${f.rule}${f.hiddenBy ? `(hidden:${f.hiddenBy})` : ''}`))].join(', ');
      console.log(`${challenged ? 'CHALLENGE ' : ''}${url}\n   output ${text.length} chars, +${out.text.length - text.length} chars, content step ${ms.toFixed(1)} ms, html ${(html.length / 1024).toFixed(0)} KB, findings ${out.findings.length}${out.redacted ? `, REDACTED ${out.redacted}` : ''}${rules ? ` [${rules}]` : ''}`);
      for (const f of out.findings.slice(0, 3)) console.log(`     · ${f.severity} ${f.rule}: "${f.excerpt}"`);
    } catch (e: any) {
      console.log(`FAILED ${url}: ${String(e.message || e).split('\n')[0]}`);
    } finally {
      await Promise.race([mcp.close(), new Promise((r) => setTimeout(r, 2000))]);
    }
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)] ?? 0;
  console.log(`--- ${name}: ${loaded} loaded, ${flagged} with findings, ${redactedPages} with redactions; wrapper adds ${loaded ? Math.round(extraChars / loaded) : 0} chars/page on average (${baseChars ? ((100 * extraChars) / baseChars).toFixed(1) : 0}% of output); content step median ${med.toFixed(1)} ms, max ${(times[times.length - 1] ?? 0).toFixed(1)} ms`);
}
process.exit(0);
