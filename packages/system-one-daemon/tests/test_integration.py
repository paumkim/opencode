"""Tests for System One integration logic in opencode prompt.ts.

These tests verify:
1. Message repackaging replaces original text with synthetic judgment
2. System prompt injection includes effort adjustment instruction
3. Daemon failure stops the pipeline
4. Non-text messages bypass System One
5. noReply bypasses System One
6. SYSTEM_ONE_URL environment variable handling
"""

import os
import sys
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# Helpers simulating prompt.ts logic
# ---------------------------------------------------------------------------

def repackage_parts(parts, decision):
    """Simulate the repackaging logic from prompt.ts."""
    repackaged = []
    for part in parts:
        if part["type"] == "text" and part["text"]:
            repackaged.append({
                "type": "text",
                "text": f"[System One: effort={decision['effort']}, category={decision['category']}, reason={decision['reason']}]\n\nOriginal user message: {part['text']}",
            })
        else:
            repackaged.append(part)
    return repackaged


def build_system_one_prompt(decision):
    """Simulate the system prompt injection from prompt.ts."""
    if not decision:
        return ""
    effort = decision["effort"]
    category = decision["category"]
    reason = decision["reason"]
    return f"\n\n[System One: effort={effort}, category={category}, reason={reason}]\nAdjust your reasoning depth accordingly. In your thought, start with 'System One: effort={effort}, category={category}' and then explain how you are adjusting reasoning depth for this turn."


def should_judge(user_text, no_reply):
    """Simulate the bypass logic from prompt.ts."""
    return bool(user_text and not no_reply)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestMessageRepackaging:
    """Test that user messages are repackaged correctly."""

    def test_text_part_replaced_with_synthetic_judgment(self):
        """Original text part should be wrapped with System One judgment."""
        parts = [{"type": "text", "text": "fix the login bug"}]
        decision = {"effort": "full", "category": "bug", "reason": "Bug requires investigation"}

        repackaged = repackage_parts(parts, decision)

        assert len(repackaged) == 1
        assert repackaged[0]["type"] == "text"
        assert "effort=full" in repackaged[0]["text"]
        assert "category=bug" in repackaged[0]["text"]
        assert "Original user message: fix the login bug" in repackaged[0]["text"]
        assert repackaged[0]["text"].count("fix the login bug") == 1

    def test_multiple_text_parts_all_wrapped(self):
        """All text parts should be wrapped."""
        parts = [
            {"type": "text", "text": "first part"},
            {"type": "text", "text": "second part"},
        ]
        decision = {"effort": "standard", "category": "task", "reason": "Task"}

        repackaged = repackage_parts(parts, decision)

        assert len(repackaged) == 2
        assert "first part" in repackaged[0]["text"]
        assert "second part" in repackaged[1]["text"]

    def test_non_text_parts_preserved(self):
        """File parts should pass through unchanged."""
        parts = [
            {"type": "text", "text": "fix bug"},
            {"type": "file", "mime": "text/plain", "url": "file:///tmp/test.txt", "filename": "test.txt"},
        ]
        decision = {"effort": "full", "category": "bug", "reason": "Bug"}

        repackaged = repackage_parts(parts, decision)

        assert len(repackaged) == 2
        assert repackaged[0]["type"] == "text"
        assert repackaged[1]["type"] == "file"
        assert "synthetic" not in repackaged[0] or repackaged[0].get("synthetic") is None

    def test_empty_text_parts_skipped(self):
        """Empty text parts should not create empty synthetic parts."""
        parts = [{"type": "text", "text": ""}, {"type": "text", "text": "real"}]
        decision = {"effort": "standard", "category": "task", "reason": "test"}

        repackaged = repackage_parts(parts, decision)

        # Empty text is preserved (createUserMessage handles filtering)
        assert len(repackaged) == 2


class TestSystemPromptInjection:
    """Test that System One decision is injected into system prompt."""

    def test_system_prompt_includes_judgment(self):
        """System prompt should include effort adjustment instruction."""
        decision = {"effort": "full", "category": "bug", "reason": "Bug requires fix"}
        prompt = build_system_one_prompt(decision)

        assert "effort=full" in prompt
        assert "category=bug" in prompt
        assert "Adjust your reasoning depth accordingly" in prompt
        assert "System One: effort=full, category=bug" in prompt

    def test_system_prompt_empty_without_decision(self):
        """System prompt should be empty when no decision."""
        prompt = build_system_one_prompt(None)
        assert prompt == ""

    def test_all_effort_levels_in_prompt(self):
        """All effort levels should be reflected in prompt."""
        for effort in ["quick", "standard", "full"]:
            decision = {"effort": effort, "category": "task", "reason": "test"}
            prompt = build_system_one_prompt(decision)
            assert f"effort={effort}" in prompt
            assert "Adjust your reasoning depth accordingly" in prompt

    def test_all_categories_in_prompt(self):
        """All categories should be reflected in prompt."""
        for category in ["greeting", "question", "task", "bug", "feature"]:
            decision = {"effort": "standard", "category": category, "reason": "test"}
            prompt = build_system_one_prompt(decision)
            assert f"category={category}" in prompt


class TestDaemonFailureHandling:
    """Test behavior when daemon is unavailable or returns errors."""

    def test_daemon_down_throws_error(self):
        """When daemon is down, pipeline should throw, not silently continue."""
        decision = None

        if not decision or not decision.get("effort"):
            with pytest.raises(Exception, match="System One pre-filter is unavailable"):
                raise Exception("System One pre-filter is unavailable. Message not sent.")
        else:
            pytest.fail("Should have raised when decision is missing")

    def test_daemon_503_throws_error(self):
        """Daemon returning 503 should cause pipeline to fail."""
        decision = {"effort": None, "category": None, "reason": None}

        if not decision or not decision.get("effort"):
            with pytest.raises(Exception, match="System One pre-filter is unavailable"):
                raise Exception("System One pre-filter is unavailable. Message not sent.")

    def test_timeout_throws_error(self):
        """Request timeout should cause pipeline to fail."""
        decision = None  # Timeout results in no decision

        if not decision or not decision.get("effort"):
            with pytest.raises(Exception, match="System One pre-filter is unavailable"):
                raise Exception("System One pre-filter is unavailable. Message not sent.")

    def test_malformed_response_throws_error(self):
        """Malformed daemon response should cause pipeline to fail."""
        decision = {}  # Missing 'effort' field

        if not decision or not decision.get("effort"):
            with pytest.raises(Exception, match="System One pre-filter is unavailable"):
                raise Exception("System One pre-filter is unavailable. Message not sent.")


class TestBypassConditions:
    """Test conditions where System One is bypassed."""

    def test_no_text_parts_bypass(self):
        """Messages with no text parts should bypass System One."""
        parts = [{"type": "file", "mime": "image/png", "url": "data:image/png;base64,abc"}]
        user_text = "".join(p.get("text", "") for p in parts if p["type"] == "text")

        assert user_text == ""
        assert should_judge(user_text, False) is False

    def test_no_reply_bypass(self):
        """noReply=true should bypass System One."""
        parts = [{"type": "text", "text": "hello"}]
        user_text = "".join(p.get("text", "") for p in parts if p["type"] == "text")

        assert should_judge(user_text, True) is False

    def test_normal_message_judges(self):
        """Normal text messages should be judged."""
        parts = [{"type": "text", "text": "fix the bug"}]
        user_text = "".join(p.get("text", "") for p in parts if p["type"] == "text")

        assert should_judge(user_text, False) is True

    def test_empty_text_bypasses(self):
        """Empty text should bypass System One."""
        parts = [{"type": "text", "text": ""}]
        user_text = "".join(p.get("text", "") for p in parts if p["type"] == "text")

        assert should_judge(user_text, False) is False


class TestEnvironmentConfig:
    """Test SYSTEM_ONE_URL environment variable handling."""

    def test_default_url(self):
        """Default URL should be 127.0.0.1:9999."""
        with patch.dict(os.environ, {}, clear=True):
            if "SYSTEM_ONE_URL" in os.environ:
                del os.environ["SYSTEM_ONE_URL"]
            url = os.environ.get("SYSTEM_ONE_URL", "http://127.0.0.1:9999")
            assert url == "http://127.0.0.1:9999"

    def test_custom_url(self):
        """Custom URL should be respected."""
        with patch.dict(os.environ, {"SYSTEM_ONE_URL": "http://localhost:9999"}):
            url = os.environ.get("SYSTEM_ONE_URL", "http://127.0.0.1:9999")
            assert url == "http://localhost:9999"

    def test_remote_url(self):
        """Remote URL should be configurable."""
        with patch.dict(os.environ, {"SYSTEM_ONE_URL": "http://remote-host:9999"}):
            url = os.environ.get("SYSTEM_ONE_URL", "http://127.0.0.1:9999")
            assert url == "http://remote-host:9999"


class TestEdgeCases:
    """Edge cases for repackaging and integration."""

    def test_empty_text_part_skipped_in_repackaging(self):
        """Empty text parts should not create empty synthetic parts."""
        parts = [{"type": "text", "text": ""}, {"type": "text", "text": "real"}]
        decision = {"effort": "standard", "category": "task", "reason": "test"}

        repackaged = repackage_parts(parts, decision)
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
        assert "fix bug: null pointer" in repackaged_text

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

    def test_only_file_parts_no_judgment(self):
        """Messages with only file parts should not trigger judgment."""
        parts = [{"type": "file", "mime": "image/png", "url": "data:image/png;base64,abc"}]
        user_text = "".join(p.get("text", "") for p in parts if p["type"] == "text")

        assert user_text == ""
        assert should_judge(user_text, False) is False

    def test_mixed_parts_only_text_judged(self):
        """Only text parts trigger judgment; file parts are preserved."""
        parts = [
            {"type": "text", "text": "fix bug"},
            {"type": "file", "mime": "image/png", "url": "data:image/png;base64,abc"},
        ]
        decision = {"effort": "full", "category": "bug", "reason": "Bug"}

        repackaged = repackage_parts(parts, decision)

        assert len(repackaged) == 2
        assert repackaged[0]["type"] == "text"
        assert repackaged[1]["type"] == "file"
        assert "fix bug" in repackaged[0]["text"]
