
from fastapi.testclient import TestClient

from app.main import app
from app.store import init_db


def test_health_and_board_and_worker_intake():
    init_db()
    client = TestClient(app)
    assert client.get("/health").json()["ok"] is True
    board = client.get("/api/board").json()
    assert "workers" in board and "tickets" in board
    wr = client.post("/api/workers", json={"name": "Pi Bot", "harness": "pi", "model": "x", "autoApproveTier": "medium"})
    assert wr.status_code == 200, wr.text
    assert wr.json()["ok"] is True
    obj = client.post("/api/objectives", json={"objective": "Write a tiny helper module", "preferredHarness": "pi"})
    assert obj.status_code == 200, obj.text
    data = obj.json()
    assert data["ok"] is True
    assert data["ticketId"]
    board = client.get("/api/board").json()
    assert len(board["tickets"]) == 1
    assert board["tickets"][0]["assignedWorkerId"]
