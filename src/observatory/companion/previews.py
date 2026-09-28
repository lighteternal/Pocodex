"""Bounded, plain-text excerpts. Never interpret message content as instructions."""

import json
import re


def excerpt(value: object, limit: int = 600) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]", "", value[:8192]).strip()
    return text[:limit - 1] + "…" if len(text) > limit else text


def questions(payload: dict) -> list[dict]:
    raw = payload.get("arguments", payload.get("input", "{}"))
    try:
        args = json.loads(raw) if isinstance(raw, str) and len(raw) <= 65536 else {}
        values = args.get("questions", []) if isinstance(args, dict) else []
        return [q for q in values[:32] if isinstance(q, dict)] if isinstance(values, list) else []
    except ValueError:
        return []


def question_previews(values: list[dict]) -> list[dict]:
    return [{"text": excerpt(q.get("question", q.get("title")), 300),
             "options": [excerpt(o.get("label") if isinstance(o, dict) else o, 100)
                         for o in q.get("options", [])[:5]]}
            for q in values[:3] if isinstance(q.get("options", []), list)]


AUTOMATIC_CONTEXT = ("<environment_context>", "<user_instructions>", "<permissions", "# AGENTS.md")


def user_text(payload: dict) -> str | None:
    """Text the user sent, or None for tool traffic and context Codex injects on its own."""
    if payload.get("type") == "user_message":
        text = payload.get("message", "")
    elif payload.get("type") == "message" and payload.get("role") == "user":
        text = "\n".join(c.get("text", "") for c in payload.get("content", [])
                         if isinstance(c, dict) and isinstance(c.get("text"), str))
    else:
        return None
    if not isinstance(text, str) or len(text) > 65536 or text.lstrip().startswith(AUTOMATIC_CONTEXT):
        return None
    return text


def answered_questions(payload: dict) -> list[tuple[str, int]]:
    text = user_text(payload)
    if text is None:
        return []
    match = re.fullmatch(r"\s*<send_user_message_question_reply>\s*(.*?)\s*</send_user_message_question_reply>\s*", text, re.S)
    if not match:
        return []
    result = []
    try:
        replies = json.loads(match[1])
        if not isinstance(replies, list):
            return []
        for reply in replies[:32]:
            ident = json.loads(reply.get("questionItemId", "null")) if isinstance(reply, dict) else None
            if (isinstance(ident, list) and len(ident) == 3 and ident[0] == "request_user_input_async"
                    and isinstance(ident[1], str) and type(ident[2]) is int):
                result.append((ident[1], ident[2]))
    except (ValueError, TypeError):
        return []
    return result
