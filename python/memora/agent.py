import json
import urllib.request
import urllib.parse
from typing import Dict, Any, Optional, List

class MemoraSnapshot:
    def __init__(self, data: Dict[str, Any]):
        self.raw = data
        self.url = data.get("url", "")
        self.title = data.get("title", "")
        self.markdown = data.get("markdown", "")
        self.action_map_text = data.get("actionMapText", "")
        self.actions = data.get("actions", [])
        self.token_estimate = data.get("tokenEstimate", 0)
        self.interactive_count = data.get("interactiveCount", 0)

    def __repr__(self) -> str:
        return f"<MemoraSnapshot '{self.title}' actions={self.interactive_count} tokens={self.token_estimate}>"

class MemoraAgent:
    """
    ⚡ MemoraAgent — Python Agent SDK for Memora Browser.
    Provides 1-line connection and high-level agentic browsing for Browser-Use,
    LangChain, CrewAI, AutoGen, and independent LLM agents.
    """

    def __init__(self, base_url: str = "http://127.0.0.1:9222"):
        self.base_url = base_url.rstrip("/")

    @classmethod
    def connect(cls, base_url: str = "http://127.0.0.1:9222") -> "MemoraAgent":
        """Connect to a running Memora Browser daemon."""
        agent = cls(base_url)
        # Verify connectivity
        req = urllib.request.Request(f"{agent.base_url}/json/version")
        with urllib.request.urlopen(req, timeout=5) as res:
            if res.status != 200:
                raise ConnectionError(f"Memora Browser did not respond on {base_url} (HTTP {res.status})")
        return agent

    def _get(self, path: str, params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            url += f"?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode("utf-8"))

    def _post(self, path: str, data: Dict[str, Any], params: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            url += f"?{urllib.parse.urlencode(params)}"
        payload = json.dumps(data).encode("utf-8")
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode("utf-8"))

    def goto(self, url: str) -> MemoraSnapshot:
        """Navigate to target URL and return distilled semantic snapshot."""
        data = self._get("/memora/goto", {"url": url})
        return MemoraSnapshot(data.get("snapshot", data))

    def snapshot(self, focus_selector: Optional[str] = None, exclude_selectors: Optional[List[str]] = None) -> MemoraSnapshot:
        """Fetch current semantic snapshot with numbered action IDs (@1, @2, ...)."""
        params = {}
        if focus_selector:
            params["focus"] = focus_selector
        if exclude_selectors:
            params["exclude"] = ",".join(exclude_selectors)
        data = self._get("/memora/snapshot", params)
        return MemoraSnapshot(data)

    def markdown(self) -> str:
        """Return clean, distilled Markdown representation."""
        url = f"{self.base_url}/memora/snapshot?format=markdown"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=10) as res:
            return res.read().decode("utf-8")

    def diff(self) -> Dict[str, Any]:
        """Compute state difference from the previous action (added, removed, mutated interactives)."""
        return self._get("/memora/diff")

    def act(self, action_id: str, text: Optional[str] = None) -> Dict[str, Any]:
        """Click or type into an element using its @actionId (e.g. '@1', '@2') or selector."""
        payload: Dict[str, Any] = {"actionId": action_id}
        if text is not None:
            payload["type"] = "type"
            payload["text"] = text
        else:
            payload["type"] = "click"
        return self._post("/memora/act", payload)

    def fill_form(self, fields: Dict[str, str], submit: bool = True) -> Dict[str, Any]:
        """Fill multiple fields in one atomic turn and optionally submit."""
        return self._post("/memora/fill-form", {"fields": fields, "submit": submit})

    def save_session(self, file_path: str) -> Dict[str, Any]:
        """Save cookies, localStorage, and sessionStorage to a file."""
        return self._post("/memora/session/save", {"filePath": file_path})

    def load_session(self, file_path: str) -> Dict[str, Any]:
        """Load session from a file."""
        return self._post("/memora/session", {"filePath": file_path})

    def to_browser_use(self) -> Dict[str, Any]:
        """Return configuration dictionary for Browser-Use in Python."""
        return {
            "cdp_url": self.base_url,
            "disable_security": True
        }

    def to_langchain_tools(self) -> List[Any]:
        """Return LangChain StructuredTool definitions."""
        try:
            from langchain.tools import tool

            @tool
            def memora_navigate(url: str) -> str:
                """Navigate to a URL and return distilled snapshot and action map."""
                snap = self.goto(url)
                return f"{snap.action_map_text}\n\n=== CONTENT ===\n{snap.markdown[:4000]}"

            @tool
            def memora_act(action_id: str, text: Optional[str] = None) -> str:
                """Click or type into an element by its action ID (@1, @2)."""
                res = self.act(action_id, text)
                diff = self.diff()
                return f"Action {action_id} result: {res.get('success')}\nDiff summary:\n{diff.get('diff', {}).get('summary', '')}"

            @tool
            def memora_diff() -> str:
                """Check what changed on the page after the last action."""
                d = self.diff().get("diff", {})
                return d.get("summary", "No changes detected.")

            return [memora_navigate, memora_act, memora_diff]
        except ImportError:
            raise ImportError("LangChain is not installed. Install via `pip install langchain` to use to_langchain_tools().")
