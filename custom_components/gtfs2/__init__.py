"""The GTFS integration."""
from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse
from homeassistant.exceptions import ConfigEntryNotReady
from homeassistant.loader import async_get_integration

from datetime import timedelta

from .const import DOMAIN, PLATFORMS, DEFAULT_PATH, DEFAULT_PATH_RT, DEFAULT_REFRESH_INTERVAL
from .redact import Redacted
from homeassistant.const import CONF_HOST
from .coordinator import GTFSUpdateCoordinator, GTFSLocalStopUpdateCoordinator
import voluptuous as vol
from .gtfs_helper import get_gtfs, update_gtfs_local_stops, get_route_departures, get_trip_stops
from .gtfs_rt_helper import get_gtfs_rt
from .gtfs_rt_cache import GTFSRTCache

_LOGGER = logging.getLogger(__name__)

# Lovelace cards bundled with the integration (served from ./www)
CARD_URL_BASE = "/gtfs2_static"
CARD_FILES = (
    "gtfs-card.js",
    "gtfs-departures-card.js",
    "gtfs-alerts-ticker.js",
)


async def _async_register_cards(hass: HomeAssistant) -> None:
    """Serve the bundled cards and load them in the frontend (once per HA run).

    Uses a separate hass.data key so the unload logic that counts config
    entries under hass.data[DOMAIN] is unaffected.
    """
    flag = f"{DOMAIN}_cards_registered"
    if hass.data.get(flag):
        return
    try:
        await hass.http.async_register_static_paths(
            [StaticPathConfig(CARD_URL_BASE, str(Path(__file__).parent / "www"), False)]
        )
        version = (await async_get_integration(hass, DOMAIN)).version
        for name in CARD_FILES:
            add_extra_js_url(hass, f"{CARD_URL_BASE}/{name}?v={version}")
        hass.data[flag] = True
    except Exception as ex:  # never block the integration over the cards
        _LOGGER.warning("Could not register gtfs2 Lovelace cards: %s", ex)

async def async_migrate_entry(hass, config_entry: ConfigEntry) -> bool:
    """Migrate old entry."""
    _LOGGER.warning("Migrating from version %s", config_entry.version)
      
    if config_entry.version == 4:

        new_options = {**config_entry.options}
        new_data = {**config_entry.data}
        new_data['route_type'] = '99'
        new_options['offset'] = 0
        new_data.pop('offset')
        new_data['agency'] = '0: ALL'        

        config_entry.version = 9
        hass.config_entries.async_update_entry(config_entry, data=new_data)
        hass.config_entries.async_update_entry(config_entry, options=new_options)          
        
    if config_entry.version == 5:

        new_data = {**config_entry.data}
        new_data['route_type'] = '99'
        new_data['agency'] = '0: ALL'

        config_entry.version = 9
        hass.config_entries.async_update_entry(config_entry, data=new_data)  
        
    if config_entry.version == 6:

        new_data = {**config_entry.data}
        new_data['agency'] = '0: ALL'

        config_entry.version = 9
        hass.config_entries.async_update_entry(config_entry, data=new_data)  

    if config_entry.version == 7 or config_entry.version == 8 or config_entry.version == 9:

        new_data = {**config_entry.data}
        new_options = {**config_entry.options}
        if config_entry.options.get('api_key', None):
            new_options['api_key_name'] = "Authorization"
            new_options['api_key'] = config_entry.options.get('api_key')
        if config_entry.options.get('x_api_key', None):
            new_options['api_key_name'] = "x_api_key"            
            new_options['api_key'] = config_entry.options.get('x_api_key')   
        if config_entry.options.get('ocp_apim_subscription_key', None):
            new_options['api_key_name'] = "ocp_apim_subscription_key"
            new_options['api_key'] = config_entry.options.get('ocp_apim_subscription_key')
            new_options.pop('ocp_apim_subscription_key')
        if "x_api_key" in config_entry.options:
            new_options.pop('x_api_key')     

        
        config_entry.version = 10
        
        hass.config_entries.async_update_entry(config_entry, data=new_data)  
        hass.config_entries.async_update_entry(config_entry, options=new_options)             

    _LOGGER.warning("Migration to version %s successful", config_entry.version)

    return True

async def _rt_push_loop(hass: HomeAssistant) -> None:
    """Refresh each registered RT URL on its own schedule."""
    import asyncio
    from .gtfs_rt_helper import get_gtfs_feed_entities_raw

    async def refresh_url(cache, url, meta):
        """Fetch and cache one registered realtime URL."""
        try:
            data = await hass.async_add_executor_job(
                get_gtfs_feed_entities_raw, url, meta["headers"], meta["label"]
            )
            if data is not None:
                cache.set(url, data)
                # Split by route_id for fast per-coordinator lookup
                if meta["label"] in ("trip_data", "vehicle_positions"):
                    registered_routes = meta.get("route_ids", set())
                    split = {}
                    for entity in data:
                        route_id = None
                        if isinstance(entity, dict):
                            if meta["label"] == "trip_data":
                                route_id = entity.get("trip_update", {}).get("trip", {}).get("route_id")
                            else:
                                route_id = entity.get("vehicle", {}).get("trip", {}).get("route_id")
                        else:
                            try:
                                if meta["label"] == "trip_data":
                                    route_id = entity.trip_update.trip.route_id
                                else:
                                    route_id = entity.vehicle.trip.route_id
                            except AttributeError:
                                pass
                        route_id = str(route_id) if route_id else None
                        route_matches = (
                            route_id
                            and (
                                not registered_routes
                                or route_id in registered_routes
                                or any(
                                    route_id.rsplit("-", 1)[-1] == registered_route.rsplit("-", 1)[-1]
                                    for registered_route in registered_routes
                                )
                            )
                        )
                        if route_matches:
                            split.setdefault(route_id, []).append(entity)
                    cache.set_split(url, split)
        except Exception as ex:
            _LOGGER.warning("RT push fetch failed for %s: %s", Redacted(url), ex)

    async def refresh_url_loop(url):
        """Refresh one URL, then wait before refreshing it again."""
        while True:
            cache = hass.data.get(DOMAIN, {}).get("rt_cache")
            if cache:
                meta = dict(cache.get_registry()).get(url)
                if meta is None:
                    return
                await refresh_url(cache, url, meta)
                refresh_interval = {
                    "vehicle_positions": 45,
                    "alerts": 60,
                }.get(meta["label"], 30)
            else:
                refresh_interval = 30
            await asyncio.sleep(refresh_interval)

    url_tasks = {}
    try:
        await asyncio.sleep(10)  # let coordinators register URLs first
        while True:
            registry = dict(
                hass.data.get(DOMAIN, {})
                .get("rt_cache")
                .get_registry()
                if hass.data.get(DOMAIN, {}).get("rt_cache")
                else []
            )

            for url, meta in registry.items():
                if url not in url_tasks:
                    url_tasks[url] = asyncio.create_task(
                        refresh_url_loop(url),
                        name="gtfs2_rt_url",
                    )
                    _LOGGER.debug("RT push loop started for: %s", Redacted(url))

            for url in set(url_tasks) - set(registry):
                url_tasks.pop(url).cancel()
                _LOGGER.debug("RT push loop stopped for: %s", Redacted(url))

            await asyncio.sleep(1)
    finally:
        for task in url_tasks.values():
            task.cancel()
        if url_tasks:
            await asyncio.gather(*url_tasks.values(), return_exceptions=True)

async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up GTFS from a config entry."""
    hass.data.setdefault(DOMAIN, {})

    await _async_register_cards(hass)

    # Shared RT feed cache — one instance per domain
    if "rt_cache" not in hass.data[DOMAIN]:
        hass.data[DOMAIN]["rt_cache"] = GTFSRTCache(ttl_seconds=45)

    # Push task — one per domain, starts after short delay so coordinators
    # can register their URLs before the first fetch cycle
    if "rt_push_task" not in hass.data[DOMAIN]:
        hass.data[DOMAIN]["rt_push_task"] = hass.async_create_background_task(
            _rt_push_loop(hass), "gtfs2_rt_push"
        )

    if entry.data.get('device_tracker_id', None):
        coordinator = GTFSLocalStopUpdateCoordinator(hass, entry)
    else:
        coordinator = GTFSUpdateCoordinator(hass, entry)
    if not coordinator.last_update_success:
        raise ConfigEntryNotReady
    hass.data[DOMAIN][entry.entry_id] = {
        "coordinator": coordinator
    }
    entry.async_on_unload(entry.add_update_listener(update_listener))
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    # Deregister this entry's RT URLs from the push cache
    cache = hass.data.get(DOMAIN, {}).get("rt_cache")
    if cache:
        cache.deregister_entry(entry.entry_id)

    if unload_ok := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        hass.data[DOMAIN].pop(entry.entry_id)

    # Cancel push task if no more gtfs2 entries remain
    remaining = [k for k in hass.data.get(DOMAIN, {}) 
                 if k not in ("rt_cache", "rt_push_task")]
    if not remaining:
        task = hass.data[DOMAIN].pop("rt_push_task", None)
        if task:
            task.cancel()
        hass.data[DOMAIN].pop("rt_cache", None)

    return unload_ok
     

def setup(hass, config):
    """Setup the service component."""

    def update_gtfs(call):
        """My GTFS Update service."""
        _LOGGER.debug("Updating GTFS with: %s", Redacted(call.data))
        get_gtfs(hass, DEFAULT_PATH, call.data, True)
        return True     

    def update_gtfs_rt_local(call):
        """My GTFS RT service."""
        _LOGGER.debug("Updating GTFS RT with: %s", Redacted(call.data))
        get_gtfs_rt(hass, DEFAULT_PATH_RT, call.data)
        return True  

    async def update_local_stops(call):
        """My GTFS Update Local Stops service."""
        _LOGGER.debug("Updating GTFS Local Stops with: %s", Redacted(call.data))
        await update_gtfs_local_stops(hass, call.data)
        return True
    
    async def extract_departures(call):
        """My GTFS Departures service."""
        _LOGGER.debug("Retrieving next departures with: %s", Redacted(call.data))
        departures = await get_route_departures(hass, call.data)
        return departures
        
    async def extract_trip_stops(call):
        """My GTFS Trip Stops service."""
        _LOGGER.debug("Retrieving trip stops with: %s", Redacted(call.data))
        stops = await get_trip_stops(hass, call.data)
        return stops       

    hass.services.register(
        DOMAIN, "update_gtfs", update_gtfs)
    hass.services.register(
        DOMAIN, "update_gtfs_rt_local", update_gtfs_rt_local)     
    hass.services.register(
        DOMAIN, "update_gtfs_local_stops", update_local_stops)
    hass.services.register(
        DOMAIN, "extract_departures", extract_departures,supports_response=SupportsResponse.OPTIONAL)
    hass.services.register(
        DOMAIN, "extract_trip_stops", extract_trip_stops,supports_response=SupportsResponse.OPTIONAL)     
    return True

async def update_listener(hass: HomeAssistant, entry: ConfigEntry):
    """Handle options update."""
    await hass.config_entries.async_reload(entry.entry_id)