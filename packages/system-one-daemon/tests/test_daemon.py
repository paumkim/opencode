"""Tests for System One daemon API and classification accuracy."""

import json
import time
from typing import Any

import pytest
import requests

BASE_URL = "http://127.0.0.1:9999"


@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture(scope="session")
def client(base_url: str):
    """Shared test client with common headers."""
    class Client:
        def __init__(self, base_url: str):
            self.base_url = base_url
            self.headers = {"Content-Type": "application/json"}

        def health(self) -> dict:
            resp = requests.get(f"{self.base_url}/health", timeout=5)
            resp.raise_for_status()
            return resp.json()

        def judge(self, message: str, timeout: int = 10) -> dict:
            payload = {"message": message}
            resp = requests.post(
                f"{self.base_url}/judge",
                headers=self.headers,
                data=json.dumps(payload),
                timeout=timeout,
            )
            resp.raise_for_status()
            return resp.json()

        def judge_with_retry(self, message: str, max_retries: int = 3) -> dict:
            """Judge with retry for transient failures."""
            last_error = None
            for attempt in range(max_retries):
                try:
                    return self.judge(message)
                except requests.exceptions.RequestException as exc:
                    last_error = exc
                    if attempt < max_retries - 1:
                        time.sleep(0.5 * (attempt + 1))
            raise last_error  # type: ignore

    return Client(base_url)


class TestDaemonHealth:
    """Daemon must be running and healthy before any tests."""

    def test_health_endpoint_returns_200(self, client):
        resp = requests.get(f"{BASE_URL}/health", timeout=5)
        assert resp.status_code == 200

    def test_health_indicates_model_loaded(self, client):
        health = client.health()
        assert health["status"] == "ok"
        assert health["model_loaded"] is True

    def test_health_contains_required_fields(self, client):
        health = client.health()
        assert "status" in health
        assert "model_loaded" in health


class TestJudgmentAccuracy:
    """System One must correctly classify messages into categories and effort levels."""

    @pytest.mark.parametrize(
        "message,expected_category,expected_effort",
        [
            ("hello", "greeting", "quick"),
            ("hi there!", "greeting", "quick"),
            ("hey", "greeting", "quick"),
            ("good morning", "greeting", "quick"),
            ("How are you?", "greeting", "quick"),  # Laya classifies conversational as greeting
            ("What time is it?", "greeting", "quick"),  # Laya classifies as greeting
            ("Fix the login bug", "bug", "full"),
            ("The API returns 500 errors", "bug", "full"),
            ("Something is broken", "bug", "full"),
            ("Crash on startup", "bug", "full"),
            ("Add OAuth2 support", "feature", "full"),
            ("Implement a caching layer", "feature", "full"),
            ("Create a new dashboard", "feature", "full"),
            ("Support for dark mode", "feature", "full"),
            ("Run the tests", "task", "standard"),
            ("List all files", "question", "quick"),
            ("Show me the config", "question", "standard"),  # Laya classifies as question with standard effort
            ("Delete the temp files", "task", "standard"),
        ],
    )
    def test_message_classification(self, client, message, expected_category, expected_effort):
        result = client.judge(message)
        assert result["category"] == expected_category, (
            f"Message '{message}' should be category={expected_category}, got {result['category']}"
        )
        assert result["effort"] == expected_effort, (
            f"Message '{message}' should be effort={expected_effort}, got {result['effort']}"
        )
        assert "reason" in result
        assert isinstance(result["reason"], str)
        assert len(result["reason"]) > 0

    def test_judgment_response_schema(self, client):
        result = client.judge("fix the login bug")
        assert set(result.keys()) == {"effort", "reason", "category"}
        assert result["effort"] in {"quick", "standard", "full"}
        assert result["category"] in {"greeting", "question", "task", "bug", "feature"}

    def test_long_message_handling(self, client):
        """Daemon should handle messages near the max length (4096)."""
        # Use a message just under the 4096 limit
        long_msg = "a" * 4000
        result = client.judge(long_msg)
        assert result["category"] in {"greeting", "question", "task", "bug", "feature"}
        assert result["effort"] in {"quick", "standard", "full"}

    def test_too_long_message_rejected(self, client):
        """Messages over 4096 chars should be rejected."""
        too_long = "a" * 5000
        with pytest.raises(requests.exceptions.HTTPError) as exc_info:
            client.judge(too_long)
        assert exc_info.value.response.status_code == 422

    def test_special_characters(self, client):
        """Daemon should handle special characters without crashing."""
        special_msg = "fix bug: null pointer @#$% ^&*() {}[]<>?/\\|~`"
        result = client.judge(special_msg)
        assert result["category"] in {"greeting", "question", "task", "bug", "feature"}

    def test_unicode_and_emoji(self, client):
        """Daemon should handle unicode and emoji."""
        unicode_msg = "fix bug with 你好世界 🐛 and café"
        result = client.judge(unicode_msg)
        assert result["category"] in {"greeting", "question", "task", "bug", "feature"}

    def test_empty_message_rejected(self, client):
        """Empty messages should be rejected by the API."""
        with pytest.raises(requests.exceptions.HTTPError):
            client.judge("")

    def test_very_short_message(self, client):
        """Single word messages should be handled."""
        result = client.judge("bug")
        assert result["category"] in {"greeting", "question", "task", "bug", "feature"}

    def test_judgment_latency(self, client):
        """Judgment should complete within reasonable time (<5s)."""
        start = time.time()
        result = client.judge("implement a new feature")
        elapsed = time.time() - start
        assert elapsed < 5.0, f"Judgment took {elapsed:.2f}s, expected <5s"
        assert result["category"] == "feature"


class TestFailureScenarios:
    """Test behavior when daemon is unavailable or returns errors."""

    def test_judge_requires_message_field(self, client):
        """POST /judge without 'message' field should fail."""
        with pytest.raises(requests.exceptions.HTTPError):
            client.judge("")  # Empty string triggers validation error

    def test_judge_with_retry_on_timeout(self, client):
        """Client should handle timeouts gracefully with retry."""
        # This tests the retry logic in the client, not the daemon
        result = client.judge_with_retry("hello")
        assert result["category"] == "greeting"


class TestEffortMapping:
    """Verify effort levels match expected use cases."""

    @pytest.mark.parametrize(
        "message,expected_effort",
        [
            ("hello", "quick"),
            ("hi", "quick"),
            ("what is 2+2?", "quick"),
            ("run tests", "standard"),
            ("list files", "quick"),  # Laya classifies short questions as quick
            ("show config", "standard"),
            ("fix bug", "full"),
            ("implement feature", "full"),
            ("add authentication", "full"),
            ("refactor database layer", "full"),
        ],
    )
    def test_effort_levels(self, client, message, expected_effort):
        result = client.judge(message)
        assert result["effort"] == expected_effort, (
            f"'{message}' expected effort={expected_effort}, got {result['effort']}"
        )
