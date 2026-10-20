"""Helpers to keep API keys out of debug logs."""
from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

MASK = "***"

# Dict keys whose values are credentials (api_key, x_api_key, apiKey,
# Ocp-Apim-Subscription-Key, Authorization, ...). Anchored at the end so that
# e.g. "api_key_name" / "api_key_location" are left readable.
_SENSITIVE_KEY = re.compile(
    r"(?:api[_-]?key|subscription[_-]?key|token|secret|password|authorization)$",
    re.IGNORECASE,
)

# Query-string parameters that look like credentials, e.g. "?api_key=abc123".
_SENSITIVE_QUERY = re.compile(
    r"([?&][^=&\s]*(?:key|token|secret|password|auth)[^=&\s]*=)[^&\s]*",
    re.IGNORECASE,
)


def _scrub(value: Any) -> Any:
    """Return a copy of value with credentials masked."""
    if isinstance(value, Mapping):
        # The user can pick any name for the API key (CONF_API_KEY_NAME).
        custom_name = value.get("api_key_name")
        return {
            key: MASK
            if val
            and isinstance(key, str)
            and (_SENSITIVE_KEY.search(key) or key == custom_name)
            else _scrub(val)
            for key, val in value.items()
        }
    if isinstance(value, (list, tuple)):
        return type(value)(_scrub(item) for item in value)
    if isinstance(value, str):
        return _SENSITIVE_QUERY.sub(r"\1" + MASK, value)
    return value


class Redacted:
    """Wrap a value for logging so credentials are masked.

    The masking only runs if the log record is actually emitted, so wrapping
    arguments costs nothing when debug logging is off.

        _LOGGER.debug("Getting gtfs with data: %s", Redacted(data))
    """

    __slots__ = ("_value",)

    def __init__(self, value: Any) -> None:
        self._value = value

    def __str__(self) -> str:
        return str(_scrub(self._value))

    __repr__ = __str__
