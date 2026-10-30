# 🪐 Orbis by Memora — Python SDK
> **The Agentic Browser. Built for Autonomous Intelligence.**  
> 🌐 **Website:** [orbis.memora.company](https://orbis.memora.company) • **Company:** [memora.company](https://memora.company)  
> ⚡ **Core Engine:** Memora Browser Engine (MBE)

Official Python SDK for **Orbis by Memora**, the agent-native, ultra-lightweight headless browser engine.

## Installation

```bash
pip install memora-orbis
```
*(Alternative alias: `pip install memora-browser`)*

## Quick Start

```python
from orbis import OrbisAgent  # or: from memora import MemoraAgent

# Connect to running Orbis daemon (started via `npx orbis` or `orbis --stealth`)
agent = OrbisAgent.connect("http://127.0.0.1:9222")

# Navigate and get compact LLM action map (<1000 tokens)
snap = agent.goto("https://example.com")
print(f"Title: {snap.title} | Tokens: ~{snap.token_estimate}")
print(snap.action_map_text)

# Direct interaction via @actionId
agent.act("@1")

# Check state changes between turns
diff = agent.diff()
print(diff["diff"]["summary"])

# Autonomous self-healing form fill
agent.fill_form({"#username": "agent_007", "#password": "secret"}, submit=True)
```

## Integration with Browser-Use

```python
from orbis import OrbisAgent
from browser_use import Agent
from langchain_openai import ChatOpenAI

agent = OrbisAgent.connect("http://127.0.0.1:9222")

# Browser-Use automatically connects over Orbis's ultra-lightweight CDP
browser_agent = Agent(
    task="Search news for AI agent announcements",
    llm=ChatOpenAI(model="gpt-4o"),
    browser_context_kwargs=agent.to_browser_use()
)
```

## Integration with LangChain

```python
from orbis import OrbisAgent

agent = OrbisAgent.connect("http://127.0.0.1:9222")
tools = agent.to_langchain_tools()
# Exported LangChain tools: memora_navigate, memora_act, memora_diff
```
