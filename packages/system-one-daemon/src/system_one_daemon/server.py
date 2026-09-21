"""System One daemon - isolated message classifier using Laya."""

import logging
import os
import signal
import sys
import time
from typing import Any, Dict, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

import laya

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
PORT = int(os.environ.get("PORT", 9999))
HOST = os.environ.get("HOST", "127.0.0.1")
MODEL_ID = os.environ.get("LAYER_MODEL_ID", "convaiinnovations/laya")

# Local model directory inside this package so the daemon can be moved/shared
_HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_MODEL_DIR = os.environ.get("SYSTEM_ONE_MODEL_DIR", os.path.join(_HERE, "..", "models"))
os.environ.setdefault("HF_HOME", LOCAL_MODEL_DIR)

# ---------------------------------------------------------------------------
# Logging (stderr only)
# ---------------------------------------------------------------------------
logger = logging.getLogger("system-one-daemon")
logger.setLevel(logging.DEBUG)
_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(logging.Formatter("[system-one-daemon] %(levelname)s: %(message)s"))
logger.addHandler(_handler)

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
agent: Optional[laya.Agent] = None
startup_error: Optional[str] = None

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="System One Daemon", version="2.0.0")


class JudgeRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4096)


class JudgeResponse(BaseModel):
    effort: str
    reason: str
    category: str


# ---------------------------------------------------------------------------
# Classification helpers
# ---------------------------------------------------------------------------
CATEGORIES = ["greeting", "question", "task", "bug", "feature"]

QUESTIONS: Dict[str, Dict[str, Any]] = {
    "category": {
        "type": "choice",
        "instructions": "What is the user doing?",
        "criteria": {
            "greeting": "Saying hello or hi",
            "question": "Asking a question",
            "task": "Giving a command like run, list, show, create, delete",
            "bug": "Something is broken or not working",
            "feature": "Asking to add something new",
        },
    }
}

REASON_MAP = {
    "greeting": "Simple greeting requires minimal effort",
    "question": "Question requires research and response",
    "task": "Task requires execution and completion",
    "bug": "Bug requires investigation and fix",
    "feature": "Feature requires design and implementation",
}


def classify_message(message: str) -> Dict[str, Any]:
    """Run Laya system_one classification on a single message."""
    result = agent.system_one(message, QUESTIONS)
    answer = result["answers"]["category"]
    category = answer.get("choice", "task")
    confidence = answer.get("confidence", 0.0)

    # Map category to effort
    effort = _map_effort(category, message, confidence)

    return {
        "effort": effort,
        "reason": REASON_MAP.get(category, "Standard processing required"),
        "category": category,
    }


def _map_effort(category: str, message: str, confidence: float) -> str:
    """Map Laya category to processing effort."""
    if category == "greeting":
        return "quick"
    elif category == "question":
        # Very short / simple questions can be quick
        msg = message.strip()
        if len(msg) < 25 and not any(
            w in msg.lower()
            for w in ["why", "how", "explain", "describe", "compare", "difference"]
        ):
            return "quick"
        return "standard"
    elif category == "task":
        return "standard"
    elif category in ("bug", "feature"):
        return "full"
    return "standard"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "status": "ok" if agent is not None else "degraded",
        "model_loaded": agent is not None,
    }


@app.post("/judge", response_model=JudgeResponse)
async def judge(request: JudgeRequest) -> JudgeResponse:
    if agent is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    try:
        result = classify_message(request.message)
        logger.info(
            "Judged: category=%s effort=%s message=%r",
            result["category"],
            result["effort"],
            request.message[:60],
        )
        return JudgeResponse(**result)
    except Exception as exc:
        logger.error("Judge error: %s", exc)
        raise HTTPException(status_code=500, detail="Internal judgment error")


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
def load_agent() -> None:
    global agent, startup_error
    logger.info("Loading Laya agent (%s)...", MODEL_ID)
    try:
        agent = laya.Agent(MODEL_ID)
        logger.info("Laya agent loaded successfully.")
    except Exception as exc:
        logger.error("Failed to load Laya agent: %s", exc)
        startup_error = str(exc)
        agent = None


def shutdown(signum: int, _frame: Any) -> None:
    sig_name = signal.Signals(signum).name
    logger.info("Received %s, shutting down...", sig_name)
    sys.exit(0)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    # Register signal handlers before anything else
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    load_agent()

    if agent is None:
        logger.error("Cannot start daemon: model failed to load.")
        return 1

    logger.info("Starting System One daemon on %s:%d", HOST, PORT)
    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        log_level="warning",
        access_log=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
