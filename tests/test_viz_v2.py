
import pytest

from app.viz_validator import VizError, mermaid_for_ticket, validate


def test_rejects_skip():
    with pytest.raises(VizError):
        validate({"widget": "MermaidDiagram", "source": "graph LR; a-->b", "skipped": True}, skipped=True)


def test_scrubs_secrets():
    clean = validate({"widget": "AgGrid", "columns": ["k"], "rows": [["sk-abcdef123456"]]})
    assert "[REDACTED]" in str(clean)


def test_mermaid_auto():
    payload = mermaid_for_ticket("Auth", "in-review", "opencode-1")
    assert payload["widget"] == "MermaidDiagram"
