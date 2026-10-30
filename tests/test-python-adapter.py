import sys
import os
import subprocess
import time

# Add python folder to sys.path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from memora import MemoraAgent

def main():
    print("Testing Python MemoraAgent SDK...")
    # Connect to running CDP server or test helper
    # We can launch a node test CDPServer for 3 seconds or test classes
    from memora.agent import MemoraSnapshot
    fake_data = {
        "url": "https://example.com",
        "title": "Example Domain",
        "actionMapText": "[@1] [link] 'More info' (selector: a)",
        "actions": [{"actionId": "@1", "role": "link", "text": "More info", "selector": "a"}],
        "markdown": "# Example Domain\nThis domain is for use in illustrative examples.",
        "tokenEstimate": 45,
        "interactiveCount": 1
    }
    snap = MemoraSnapshot(fake_data)
    assert snap.title == "Example Domain"
    assert snap.interactive_count == 1
    assert snap.token_estimate == 45
    print("[OK] MemoraSnapshot data mapping verified.")

    agent = MemoraAgent("http://127.0.0.1:9222")
    bu = agent.to_browser_use()
    assert bu["cdp_url"] == "http://127.0.0.1:9222"
    assert bu["disable_security"] is True
    print("[OK] Python Browser-Use integration config verified.")
    print("ALL Python SDK tests passed successfully!")

if __name__ == "__main__":
    main()
