"""Shared RT feed cache for the GTFS2 integration — push-based design with route splitting."""
from __future__ import annotations
import datetime
import logging
import threading

from .redact import Redacted

_LOGGER = logging.getLogger(__name__)


class GTFSRTCache:
    """Thread-safe RT feed cache with URL registry and per-route split cache."""

    def __init__(self, ttl_seconds: int = 90) -> None:
        self._ttl = ttl_seconds
        self._cache: dict[str, dict] = {}        # url -> {data, fetched_at}
        self._split_cache: dict[str, dict] = {}  # url -> {route_id -> [entities], fetched_at}
        self._registry: dict[str, dict] = {}     # url -> {headers, label, entry_ids}
        self._lock = threading.Lock()

    # ── URL registry ──────────────────────────────────────────────────────────

    def register_url(self, url: str, headers, label: str, entry_id: str, route_id: str = None) -> None:
        if not url or not url.startswith("http"):
            return
        with self._lock:
            if url not in self._registry:
                self._registry[url] = {"headers": headers, "label": label, "entry_ids": set()}
                _LOGGER.debug("RT push registry: added url=%s entry=%s", Redacted(url), entry_id)
            self._registry[url]["entry_ids"].add(entry_id)
            if route_id:
                self._registry[url].setdefault("route_ids", set()).add(str(route_id))

    def deregister_entry(self, entry_id: str) -> None:
        """Remove an entry's URLs from the registry. Cleans up empty URLs."""
        with self._lock:
            to_remove = []
            for url, meta in self._registry.items():
                meta["entry_ids"].discard(entry_id)
                if not meta["entry_ids"]:
                    to_remove.append(url)
            for url in to_remove:
                del self._registry[url]
                self._cache.pop(url, None)
                self._split_cache.pop(url, None)
                _LOGGER.debug("RT push registry: removed url=%s (no more entries)", Redacted(url))

    def get_registry(self) -> list[tuple[str, dict]]:
        """Return a snapshot of the registry for the push task to iterate."""
        with self._lock:
            return list(self._registry.items())

    # ── Raw cache read/write ──────────────────────────────────────────────────

    def get(self, url: str):
        """Return the most recent cached entity list, including stale data."""
        entry = self._cache.get(url)
        if entry is None:
            _LOGGER.debug("RT cache cold for: %s", Redacted(url))
            return None
        age = (datetime.datetime.utcnow() - entry["fetched_at"]).total_seconds()
        if age > self._ttl:
            _LOGGER.debug(
                "RT cache stale (%.0fs > %ds), using last data for: %s",
                age,
                self._ttl,
                Redacted(url),
            )
            return entry["data"]
        _LOGGER.debug("RT cache hit (%.0fs old) for: %s", age, Redacted(url))
        return entry["data"]

    def set(self, url: str, data) -> None:
        """Store full entity list. Called by push task after fetch."""
        with self._lock:
            self._cache[url] = {
                "data": data,
                "fetched_at": datetime.datetime.utcnow(),
            }
        _LOGGER.debug("RT cache stored for: %s", Redacted(url))

    # ── Split cache read/write ────────────────────────────────────────────────

    def set_split(self, url: str, split: dict[str, list]) -> None:
        """Store pre-split entities keyed by route_id. Called by push task after fetch."""
        with self._lock:
            self._split_cache[url] = {
                "data": split,
                "fetched_at": datetime.datetime.utcnow(),
            }
        _LOGGER.debug("RT split cache stored for: %s (%d routes)", Redacted(url), len(split))

    def get_for_route(self, url: str, route_id: str):
        """Return route entities, including stale data while refresh is pending."""
        entry = self._split_cache.get(url)
        if entry is None:
            _LOGGER.debug("RT split cache cold for: %s", Redacted(url))
            return None
        age = (datetime.datetime.utcnow() - entry["fetched_at"]).total_seconds()
        if age > self._ttl:
            _LOGGER.debug(
                "RT split cache stale (%.0fs > %ds), using last data for: %s",
                age,
                self._ttl,
                Redacted(url),
            )
        requested_route = str(route_id)
        result = entry["data"].get(requested_route)
        if result is None:
            requested_short_route = requested_route.rsplit("-", 1)[-1]
            result = next(
                (
                    entities
                    for cached_route, entities in entry["data"].items()
                    if str(cached_route).rsplit("-", 1)[-1] == requested_short_route
                ),
                [],
            )
        _LOGGER.debug("RT split cache hit for route %s: %d entities", route_id, len(result))
        return result

    def invalidate(self, url: str | None = None) -> None:
        """Invalidate one URL or the entire cache."""
        with self._lock:
            if url:
                self._cache.pop(url, None)
                self._split_cache.pop(url, None)
            else:
                self._cache.clear()
                self._split_cache.clear()
        _LOGGER.debug("RT cache invalidated: %s", Redacted(url or "all"))