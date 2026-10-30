# 🪐 Orbis by Memora — Python SDK
> **The Agentic Browser. Built for Autonomous Intelligence.**  
> 🌐 **Website:** [orbis.memora.company](https://orbis.memora.company) • **Company:** [memora.company](https://memora.company)  
> ⚡ **Core Engine:** Memora Browser Engine (MBE)

Official Python client for **Orbis by Memora**, the agent-native, ultra-lightweight headless browser engine.

## Installation

```bash
pip install memora-browser
```

## Quick Start

```python
from memora import OrbisAgent # (or MemoraAgent)

# Connect to running Orbis instance (launched via `npx memora-browser` or `npx orbis`)
agent = OrbisAgent.connect("http://127.0.0.1:9222")

# Navigate and get compact LLM action map (<1000 tokens)
snap = agent.goto("https://news.ycombinator.com")
print(snap.action_map_text)

# Direct interaction via @actionId
agent.act("@1")

# Check state changes
diff = agent.diff()
print(diff["diff"]["summary"])
```

## Integration with Browser-Use

```python
from memora import OrbisAgent

agent = OrbisAgent.connect("http://127.0.0.1:9222")
config = agent.to_browser_use()
# Use config in Browser-Use controller
```

