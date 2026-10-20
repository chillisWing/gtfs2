"""Data Update coordinator for the GTFS integration."""
from __future__ import annotations

import datetime
from datetime import timedelta
import logging


from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
import homeassistant.util.dt as dt_util

from .const import (
    DEFAULT_PATH,
    DEFAULT_REFRESH_INTERVAL,
    DEFAULT_LOCAL_STOP_REFRESH_INTERVAL,
    DEFAULT_LOCAL_STOP_TIMERANGE,
    DEFAULT_LOCAL_STOP_RADIUS,
    CONF_API_KEY,
    CONF_API_KEY_NAME,
    CONF_API_KEY_LOCATION,
    CONF_ACCEPT_HEADER_PB,
    ATTR_DUE_IN,
    ATTR_LATITUDE,
    ATTR_LONGITUDE,
    ATTR_RT_UPDATED_AT,
    ICON,
    ICONS,
    DOMAIN
)
from .const import CONF_VEHICLE_SLOTS, DEFAULT_VEHICLE_SLOTS
from .gtfs_helper import get_gtfs, get_next_departure, check_datasource_index, create_trip_geojson, check_extracting, get_local_stops_next_departures
from .gtfs_rt_helper import get_next_services, get_rt_alerts
from .redact import Redacted

_LOGGER = logging.getLogger(__name__)


class GTFSUpdateCoordinator(DataUpdateCoordinator):
    """Data update coordinator for the GTFS integration."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass=hass,
            logger=_LOGGER,
            name=entry.entry_id,
            update_interval=timedelta(seconds=entry.options.get("refresh_interval", DEFAULT_REFRESH_INTERVAL)),
        )
        self.config_entry = entry
        self.hass = hass
        self._static_cache = None
        self._pygtfs = ""
        self._data: dict[str, str] = {}
        self._vehicle_slot_by_id: dict[str, int] = {}

    async def _async_update_data(self) -> dict[str, str]:
        """Get the latest data from GTFS and GTFS relatime, depending refresh interval"""
        data = self.config_entry.data
        options = self.config_entry.options
        previous_data = None if self.data is None else self.data.copy()
        _LOGGER.debug("Previous data: %s", Redacted(previous_data))

        if self._pygtfs and hasattr(self._pygtfs, 'session'):
            try:
                self._pygtfs.session.close()
                self._pygtfs.engine.dispose()
            except Exception:
                pass

        self._pygtfs = get_gtfs(
            self.hass, DEFAULT_PATH, data, False
        )

        self._data = {
            "schedule": self._pygtfs,
            "origin": data["origin"],
            "destination": data["destination"],
            "offset": options["offset"] if "offset" in options else 0,
            "include_tomorrow": data.get("include_tomorrow", False),
            "gtfs_dir": DEFAULT_PATH,
            "name": data["name"],
            "file": data["file"],
            "route_type": data["route_type"],
            "route": data["route"],
            "direction": str(data.get("direction", "")),
            "extracting": False,
            "next_departure": {},
            "next_departure_realtime_attr": {},
            "alert": {},
            "static_cache": self._static_cache
        }

        if check_extracting(self.hass, self.hass.config.path(self._data['gtfs_dir']), self._data['file']):
            _LOGGER.debug("Cannot update this sensor as still unpacking: %s", self._data["file"])
            if previous_data is not None:
                previous_data["extracting"] = True
            return previous_data

        # determine static + rt or only static (refresh schedule depending)
        #1. sensor exists with data but refresh interval not yet reached, use existing data
        if previous_data is not None and (datetime.datetime.fromisoformat(previous_data["gtfs_updated_at"]) + timedelta(seconds=options.get("refresh_interval", DEFAULT_REFRESH_INTERVAL))) > dt_util.utcnow() + timedelta(seconds=1):
            run_static = False
            _LOGGER.debug("No run static refresh: sensor exists but not yet refresh for name: %s", data["name"])
        #2. sensor exists and refresh interval reached, get static data
        else:
            run_static = True
            _LOGGER.debug("Run static refresh: sensor without gtfs data OR refresh for name: %s", data["name"])

        if not run_static:
            # do nothing awaiting refresh interval and use existing data
            self._data = previous_data
        else:
            check_index = await self.hass.async_add_executor_job(
                    check_datasource_index, self.hass, self._pygtfs, self.hass.config.path(DEFAULT_PATH), data["file"]
                )

            try:
                self._data["next_departure"] = await self.hass.async_add_executor_job(
                    get_next_departure, self.hass, self._data
                )
                self._static_cache = self._data.get("static_cache")
                self._data["gtfs_updated_at"] = dt_util.utcnow().isoformat()
            except Exception as ex:  # pylint: disable=broad-except
                _LOGGER.error("Error getting gtfs data from generic helper: %s", ex)
                return None
            _LOGGER.debug("GTFS coordinator data from helper: %s", self._data["next_departure"])

        # collect and return rt attributes
        # STILL REQUIRES A SOLUTION IF CONNECTION TIMING OUT
        if "real_time" in options:
            if options["real_time"]:
                self._get_next_service = {}
                """Initialize the info object."""
                self._route_delimiter = None
                self._headers = None
                self._trip_update_url = options.get("trip_update_url", None)
                self._vehicle_position_url = options.get("vehicle_position_url", None)
                self._icon = ICONS.get(int(self._data["route_type"]), ICON)
                self._route_type = str(self._data["route_type"])
                self._alerts_url = options.get("alerts_url", None)
                if options.get(CONF_API_KEY_LOCATION, None) == "query_string":
                  if options.get(CONF_API_KEY, None):
                    self._trip_update_url = self._trip_update_url + "?" + options[CONF_API_KEY_NAME] + "=" + options[CONF_API_KEY]
                    self._vehicle_position_url = self._vehicle_position_url + "?" + options[CONF_API_KEY_NAME] + "=" + options[CONF_API_KEY]
                    self._alerts_url = self._alerts_url + "?" + options[CONF_API_KEY_NAME] + "=" + options[CONF_API_KEY]
                if options.get(CONF_API_KEY_LOCATION, None) == "header":
                    self._headers = {options[CONF_API_KEY_NAME]: options[CONF_API_KEY]}
                    if options.get(CONF_ACCEPT_HEADER_PB, False):
                        self._headers["Accept"] = "application/x-protobuf"
                self.info = {}

                if not self._data.get("next_departure"):
                    # No scheduled departure this cycle (e.g. weekend/no-service
                    # gap). There's nothing meaningful to fetch RT data against,
                    # so skip the RT block cleanly instead of raising.
                    _LOGGER.debug(
                        "GTFS RT: no next_departure for %s, skipping realtime fetch this cycle",
                        data["name"],
                    )
                    self._data["next_departure_realtime_attr"] = {}
                    self._data["alert"] = {}
                    return self._data

                self._route_id = self._data["next_departure"].get("route_id", None)
                if self._route_id == None:
                    _LOGGER.debug("GTFS RT: no route_id in sensor data, using route_id from config_entry")
                    self._route_id = data["route"].split(": ")[0]

                origin_stop_id = self._data["next_departure"].get("origin_stop_id")
                if not origin_stop_id:
                    _LOGGER.debug(
                        "GTFS RT: no origin_stop_id in next_departure for %s, skipping realtime fetch this cycle",
                        data["name"],
                    )
                    self._data["next_departure_realtime_attr"] = {}
                    self._data["alert"] = {}
                    return self._data
                self._stop_id = origin_stop_id.split(": ")[0]
                self._stop_sequence = self._data["next_departure"].get("origin_stop_sequence")
                configured_destination = str(data.get("destination") or "").split(": ", 1)[0].strip()
                self._has_configured_destination = bool(configured_destination)
                self._destination_id = (
                    configured_destination
                    or self._data["next_departure"].get("destination_stop_id", "")
                )
                self._trip_id = self._data.get('next_departure', {}).get('trip_id', None)
                self._trip_ids = {
                    str(trip_id)
                    for trip_id in self._data.get("next_departure", {}).get(
                        "next_departures_trip_id", []
                    )
                }
                if self._trip_id:
                    self._trip_ids.add(str(self._trip_id))
                self._trip_short_name = self._data.get('next_departure', {}).get('trip_short_name', None)
                self._direction = str(self._data.get('next_departure', {}).get('trip_direction_id', data["direction"]))
                self._relative = False
                self._rt_cache = self.hass.data.get(DOMAIN, {}).get("rt_cache")

                # Register RT URLs with the push cache so the push task fetches them
                if self._rt_cache:
                    if self._trip_update_url:
                        self._rt_cache.register_url(self._trip_update_url, self._headers, "trip_data", self.config_entry.entry_id, self._route_id)
                    if self._vehicle_position_url:
                        self._rt_cache.register_url(self._vehicle_position_url, self._headers, "vehicle_positions", self.config_entry.entry_id, self._route_id)
                    if self._alerts_url:
                        self._rt_cache.register_url(self._alerts_url, self._headers, "alerts", self.config_entry.entry_id, self._route_id)
                try:
                    self._get_rt_alerts = await self.hass.async_add_executor_job(get_rt_alerts, self)
                    self._get_next_service = await self.hass.async_add_executor_job(get_next_services, self)
                    self._data["next_departure_realtime_attr"] = self._get_next_service
                    self._data["next_departure_realtime_attr"]["gtfs_rt_updated_at"] = dt_util.utcnow()
                    self._data["geojson"] = getattr(
                        self,
                        "geojson",
                        {"type": "FeatureCollection", "features": []},
                    )
                    self._data["vehicles"] = self._assign_vehicle_slots(
                        self._data["geojson"].get("features", [])
                    )
                    self._data["vehicle_occupancy"] = {
                        str(feature.get("properties", {}).get("trip_id")): feature.get(
                            "properties", {}
                        ).get("occupancy_status")
                        for feature in self._data["geojson"].get("features", [])
                        if feature.get("properties", {}).get("trip_id")
                        and feature.get("properties", {}).get("occupancy_status")
                    }
                    self._data["alert"] = self._get_rt_alerts
                except Exception as ex:  # pylint: disable=broad-except
                  _LOGGER.error("Error getting gtfs realtime data, for origin: %s with error: %s", data["origin"], ex)
                  return self._data

            else:
                _LOGGER.debug("GTFS RT: RealTime = false, selected in entity options")
        else:
            _LOGGER.debug("GTFS RT: RealTime not selected in entity options")

        return self._data

    def _assign_vehicle_slots(self, features: list[dict]) -> list[dict | None]:
        """Assign active vehicles to stable route-level tracker slots."""
        max_slots = self.config_entry.options.get(
            CONF_VEHICLE_SLOTS, DEFAULT_VEHICLE_SLOTS
        )
        active: dict[str, dict] = {}
        for feature in features:
            properties = feature.get("properties", {})
            vehicle_id = str(
                properties.get("vehicle_id")
                or properties.get("trip_id")
                or properties.get("id")
            )
            coordinates = feature.get("geometry", {}).get("coordinates", [])
            if len(coordinates) != 2:
                continue
            active[vehicle_id] = {
                "vehicle_id": vehicle_id,
                "trip_id": properties.get("trip_id"),
                "route_id": properties.get("route_id"),
                "direction_id": properties.get("direction_id"),
                "vehicle_label": properties.get("vehicle_label", ""),
                "occupancy_status": properties.get("occupancy_status"),
                "latitude": coordinates[1],
                "longitude": coordinates[0],
            }

        assignments = {
            vehicle_id: slot
            for vehicle_id, slot in self._vehicle_slot_by_id.items()
            if vehicle_id in active
        }
        used_slots = set(assignments.values())
        for vehicle_id in sorted(active):
            if vehicle_id in assignments:
                continue
            free_slots = [
                slot for slot in range(1, max_slots + 1) if slot not in used_slots
            ]
            if not free_slots:
                break
            assignments[vehicle_id] = free_slots[0]
            used_slots.add(free_slots[0])

        self._vehicle_slot_by_id = assignments
        slots: list[dict | None] = [None] * max_slots
        for vehicle_id, slot in assignments.items():
            slots[slot - 1] = active[vehicle_id]
        return slots

class GTFSLocalStopUpdateCoordinator(DataUpdateCoordinator):
    """Data update coordinator for getting local stops."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        """Initialize the coordinator."""
        super().__init__(
            hass=hass,
            logger=_LOGGER,
            name=entry.entry_id,
            update_interval=timedelta(seconds=entry.options.get("local_stop_refresh_interval", DEFAULT_LOCAL_STOP_REFRESH_INTERVAL)),
        )
        self.config_entry = entry
        self.hass = hass

        self._pygtfs = ""
        self._data: dict[str, str] = {}

    async def _async_update_data(self) -> dict[str, str]:
        """Get the latest data from GTFS and GTFS relatime, depending refresh interval"""
        data = self.config_entry.data
        options = self.config_entry.options
        previous_data = None if self.data is None else self.data.copy()
        _LOGGER.debug("Previous data: %s", Redacted(previous_data))
        self._realtime = False
        if "real_time" in options:
            if options["real_time"]:
                self._realtime = True
                self._get_next_service = {}
                """Initialize the info object."""
                self._route_delimiter = None
                self._headers = {}
                self._trip_update_url = options.get("trip_update_url", None)
                self._vehicle_position_url = options.get("vehicle_position_url", None)
                self._alerts_url = options.get("alerts_url", None)
                if options.get(CONF_API_KEY_LOCATION, None) == "query_string":
                  if options.get(CONF_API_KEY, None):
                    self._trip_update_url = self._trip_update_url + "?" + options[CONF_API_KEY_NAME] + "=" + options[CONF_API_KEY]
                if options.get(CONF_API_KEY_LOCATION, None) == "header":
                    self._headers = {options[CONF_API_KEY_NAME]: options[CONF_API_KEY]}
                    self._headers[CONF_API_KEY_LOCATION] = options.get(CONF_API_KEY_LOCATION,None)
                    self._headers[CONF_API_KEY_NAME] = options.get(CONF_API_KEY_NAME, None)
                    self._headers[CONF_API_KEY] = options.get(CONF_API_KEY, None)
                    self._headers[CONF_ACCEPT_HEADER_PB] = options.get(CONF_ACCEPT_HEADER_PB, False)
                _LOGGER.debug("RT header: %s", Redacted(self._headers))

        if self._pygtfs and hasattr(self._pygtfs, 'session'):
            try:
                self._pygtfs.session.close()
                self._pygtfs.engine.dispose()
            except Exception:
                pass

        self._pygtfs = get_gtfs(
            self.hass, DEFAULT_PATH, data, False
        )
        self._data = {
            "schedule": self._pygtfs,
            "include_tomorrow": True,
            "gtfs_dir": DEFAULT_PATH,
            "name": data["name"],
            "file": data["file"],
            "offset": options["offset"] if "offset" in options else 0,
            "timerange": options.get("timerange", DEFAULT_LOCAL_STOP_TIMERANGE),
            "radius": options.get("radius", DEFAULT_LOCAL_STOP_RADIUS),
            "device_tracker_id": data["device_tracker_id"],
            "extracting": False,
        }
        self._data["gtfs_updated_at"] = dt_util.utcnow().isoformat()

        if check_extracting(self.hass, self.hass.config.path(self._data['gtfs_dir']), self._data['file']):
            _LOGGER.debug("Cannot update this sensor as still unpacking: %s", self._data["file"])
            previous_data["extracting"] = True
            return previous_data
        try:
            self._data["local_stops_next_departures"] = await self.hass.async_add_executor_job(
                    get_local_stops_next_departures, self
                )
        except Exception as ex:
            raise UpdateFailed(f"Error in getting local stops data: {ex}")
        _LOGGER.debug("Data from coordinator: %s", Redacted(self._data))
        return self._data