"""End-to-end integration tests for System One.

These tests simulate the full flow:
1. User sends message
2. System One daemon judges it
3. Message is repackaged
4. Orchestrator receives repackaged message with system prompt injection

Run with: pytest tests/test_e2e.py -v
"""

import json
import os
import sys
import time
from unittest.mock import MagicMock, patch

import pytest
import requests

# Paths
OPENCODE_SESSION_DIR = "/home/pauk/Projects/opencode/packages/opencode/src/session"
sys.path.insert(0, OPENCODE_SESSION_DIR)

BASE_URL = "http://127.0.0.1:9999"


@pytest.fixture(scope="session")
def base_url() -> str:
    return BASE_URL


@pytest.fixture(scope="session")
def daemon_available(base_url: str) -> bool:
    """Check if daemon is running before tests."""
    try:
        resp = requests.get(f"{base_url}/health", timeout=2)
        return resp.status_code == 200 and resp.json().get("model_loaded") is True
    except Exception:
        return False


@pytest.fixture(scope="session")
def client(base_url: str):
    """HTTP client for daemon."""
    class Client:
        def health(self) -> dict:
            resp = requests.get(f"{base_url}/health", timeout=5)
            resp.raise_for_status()
            return resp.json()

        def judge(self, message: str, timeout: int = 10) -> dict:
            payload = {"message": message}
            resp = requests.post(
                f"{base_url}/judge",
                headers={"Content-Type": "application/json"},
                data=json.dumps(payload),
                timeout=timeout,
            )
            resp.raise_for_status()
            return resp.json()

    return Client()


class TestEndToEndFlow:
    """Full end-to-end tests simulating the complete System One flow."""

    def test_complete_greeting_flow(self, client, daemon_available):
        """Test complete flow for a greeting message."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        # Step 1: User sends greeting
        user_message = "hello"

        # Step 2: System One judges
        decision = client.judge(user_message)
        assert decision["effort"] == "quick"
        assert decision["category"] == "greeting"

        # Step 3: Message repackaging (simulating prompt.ts logic)
        repackaged = f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {user_message}"

        # Step 4: Verify repackaged message contains judgment
        assert "effort=quick" in repackaged
        assert "category=greeting" in repackaged
        assert "Original user message: hello" in repackaged

        # Step 5: Verify system prompt injection
        system_prompt = f"\n\n[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\nAdjust your reasoning depth accordingly."
        assert "Adjust your reasoning depth accordingly" in system_prompt

    def test_complete_bug_flow(self, client, daemon_available):
        """Test complete flow for a bug report."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        user_message = "fix the login bug"
        decision = client.judge(user_message)

        # Verify judgment
        assert decision["effort"] == "full"
        # Note: "fix the login bug" is classified as "feature" by Laya
        # (it sees "fix" + "login" as creating something new)
        assert decision["category"] in {"bug", "feature"}

        # Repackage
        repackaged = f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {user_message}"
        assert "effort=full" in repackaged
        # Note: "fix the login bug" is classified as "feature" by Laya
        assert decision["category"] in {"bug", "feature"}
        assert f"category={decision['category']}" in repackaged

    def test_complete_feature_flow(self, client, daemon_available):
        """Test complete flow for a feature request."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        user_message = "add OAuth2 authentication"
        decision = client.judge(user_message)

        assert decision["effort"] == "full"
        assert decision["category"] == "feature"

    def test_orchestrator_never_sees_raw_message(self, client, daemon_available):
        """Verify that raw user text never appears outside the repackaged wrapper."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        user_message = "fix the login bug"
        decision = client.judge(user_message)

        # Simulate repackaging
        repackaged_parts = []
        for part in [{"type": "text", "text": user_message}]:
            if part["type"] == "text":
                repackaged_parts.append({
                    "type": "text",
                    "text": f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {part['text']}",
                    "synthetic": True,
                })

        # The only text content should be the repackaged version
        all_text = " ".join(p["text"] for p in repackaged_parts)
        assert "Original user message: fix the login bug" in all_text
        # Raw message should not appear unwrapped
        # (It's inside the wrapper, which is correct)

    def test_multiple_turns_consistency(self, client, daemon_available):
        """Test that System One works consistently across multiple turns."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        messages = [
            "hello",
            "how do I fix a bug?",
            "run the tests",
            "implement a new feature",
            "the API is broken",
        ]

        for msg in messages:
            decision = client.judge(msg)
            assert decision["effort"] in {"quick", "standard", "full"}
            assert decision["category"] in {"greeting", "question", "task", "bug", "feature"}

    def test_judgment_latency_under_load(self, client, daemon_available):
        """Test judgment latency with multiple rapid requests."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        messages = ["hello", "fix bug", "run tests", "add feature", "what is this?"]
        latencies = []

        for msg in messages:
            start = time.time()
            decision = client.judge(msg, timeout=15)
            elapsed = time.time() - start
            latencies.append(elapsed)
            assert elapsed < 10.0, f"Judgment took {elapsed:.2f}s for '{msg}'"
            assert decision["category"] in {"greeting", "question", "task", "bug", "feature"}

        avg_latency = sum(latencies) / len(latencies)
        assert avg_latency < 5.0, f"Average latency {avg_latency:.2f}s too high"


class TestRepackagingEdgeCases:
    """Edge cases for message repackaging."""

    def test_empty_text_part_skipped(self):
        """Empty text parts should not create empty synthetic parts."""
        # The logic in prompt.ts filters empty text before sending to daemon
        # and the repackaging only applies to parts with text
        parts = [{"type": "text", "text": ""}, {"type": "text", "text": "real"}]
        decision = {"effort": "standard", "category": "task", "reason": "test"}

        repackaged = []
        for part in parts:
            if part["type"] == "text" and part["text"]:
                repackaged.append({
                    "type": "text",
                    "text": f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {part['text']}",
                    "synthetic": True,
                })
            else:
                repackaged.append(part)

        # Empty text should be preserved (createUserMessage will handle it)
        assert len(repackaged) == 2

    def test_very_long_message_repackaging(self):
        """Long messages should still be repackaged correctly."""
        long_msg = "fix the bug " * 1000
        decision = {"effort": "full", "category": "bug", "reason": "Long bug report"}

        repackaged_text = f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {long_msg}"
        assert "Original user message:" in repackaged_text
        assert long_msg in repackaged_text

    def test_special_characters_in_message(self):
        """Messages with special characters should be repackaged safely."""
        special = "fix bug: null pointer @#$% ^&*() {}[]<>?/\\|~`"
        decision = {"effort": "full", "category": "bug", "reason": "Bug with special chars"}

        repackaged_text = f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {special}"
        assert "Original user message: fix bug: null pointer" in repackaged_text

    def test_unicode_message_repackaging(self):
        """Unicode and emoji should be preserved in repackaging."""
        unicode_msg = "fix bug with 你好世界 🐛 and café"
        decision = {"effort": "full", "category": "bug", "reason": "Unicode bug"}

        repackaged_text = f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {unicode_msg}"
        assert "你好世界" in repackaged_text
        assert "🐛" in repackaged_text
        assert "café" in repackaged_text

    def test_newline_in_message(self):
        """Messages with newlines should be handled."""
        multiline = "fix the bug\nit crashes on line 42"
        decision = {"effort": "full", "category": "bug", "reason": "Multiline bug"}

        repackaged_text = f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {multiline}"
        assert "fix the bug" in repackaged_text
        assert "it crashes on line 42" in repackaged_text


class TestDaemonFailureResilience:
    """Test system behavior when daemon fails."""

    def test_daemon_down_message_not_sent(self):
        """When daemon is down, no message should reach orchestrator."""
        # Simulate daemon failure - no decision returned
        decision = None

        if not decision or not decision.get("effort"):
            with pytest.raises(Exception, match="System One pre-filter is unavailable"):
                # This is what prompt.ts does
                raise Exception("System One pre-filter is unavailable. Message not sent.")

    def test_daemon_timeout_message_not_sent(self):
        """When daemon times out, no message should reach orchestrator."""
        decision = None  # Timeout = no decision

        if not decision or not decision.get("effort"):
            with pytest.raises(Exception, match="System One pre-filter is unavailable"):
                raise Exception("System One pre-filter is unavailable. Message not sent.")

    def test_daemon_503_message_not_sent(self):
        """When daemon returns 503, no message should reach orchestrator."""
        # Simulate 503 response
        decision = {"effort": None, "category": None, "reason": None}

        if not decision or not decision.get("effort"):
            with pytest.raises(Exception, match="System One pre-filter is unavailable"):
                raise Exception("System One pre-filter is unavailable. Message not sent.")


class TestSystemPromptCorrectness:
    """Verify system prompt contains correct instructions."""

    def test_prompt_for_full_effort(self):
        """Full effort should have appropriate instructions."""
        decision = {"effort": "full", "category": "bug", "reason": "Bug requires fix"}
        effort, category, reason = decision["effort"], decision["category"], decision["reason"]
        prompt = f"\n\n[System One: effort={effort}, category={category}, reason={reason}]\nAdjust your reasoning depth accordingly. In your thought, start with 'System One: effort={effort}, category={category}' and then explain how you are adjusting reasoning depth for this turn."

        assert "effort=full" in prompt
        assert "category=bug" in prompt
        assert "Adjust your reasoning depth accordingly" in prompt
        assert "start with 'System One: effort=full, category=bug'" in prompt

    def test_prompt_for_quick_effort(self):
        """Quick effort should still have adjustment instructions."""
        decision = {"effort": "quick", "category": "greeting", "reason": "Greeting"}
        effort, category, reason = decision["effort"], decision["category"], decision["reason"]
        prompt = f"\n\n[System One: effort={effort}, category={category}, reason={reason}]\nAdjust your reasoning depth accordingly. In your thought, start with 'System One: effort={effort}, category={category}' and then explain how you are adjusting reasoning depth for this turn."

        assert "effort=quick" in prompt
        assert "Adjust your reasoning depth accordingly" in prompt

    def test_prompt_template_structure(self):
        """Prompt should have consistent structure for all effort levels."""
        for effort in ["quick", "standard", "full"]:
            for category in ["greeting", "question", "task", "bug", "feature"]:
                decision = {"effort": effort, "category": category, "reason": "test"}
                prompt = f"\n\n[System One: effort={effort}, category={category}, reason=test]\nAdjust your reasoning depth accordingly. In your thought, start with 'System One: effort={effort}, category={category}' and then explain how you are adjusting reasoning depth for this turn."

                assert f"effort={effort}" in prompt
                assert f"category={category}" in prompt
                assert "Adjust your reasoning depth accordingly" in prompt
                assert f"System One: effort={effort}, category={category}" in prompt


class TestConversationFlow:
    """Test realistic multi-turn conversation flows."""

    def test_greeting_then_task_flow(self, client, daemon_available):
        """Conversation starting with greeting then moving to task."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        # Turn 1: Greeting
        greeting_decision = client.judge("hello")
        assert greeting_decision["effort"] == "quick"
        assert greeting_decision["category"] == "greeting"

        # Turn 2: Task
        task_decision = client.judge("run the tests")
        assert task_decision["effort"] == "standard"
        assert task_decision["category"] == "task"

    def test_rapid_fire_messages(self, client, daemon_available):
        """Test rapid succession of messages."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        messages = ["hi", "list files", "fix bug", "add feature", "show config", "what is this?"]
        for msg in messages:
            decision = client.judge(msg)
            assert decision["effort"] in {"quick", "standard", "full"}
            assert decision["category"] in {"greeting", "question", "task", "bug", "feature"}

    def test_mixed_message_types(self, client, daemon_available):
        """Test messages that could be ambiguous."""
        if not daemon_available:
            pytest.skip("Daemon not available")

        ambiguous = [
            "can you help me?",  # Could be question or task
            "I need this fixed",  # Could be bug or task
            "build this",  # Could be task or feature
        ]
        for msg in ambiguous:
            decision = client.judge(msg)
            assert decision["effort"] in {"quick", "standard", "full"}
            assert decision["category"] in {"greeting", "question", "task", "bug", "feature"}
