"""GTFS vehicle device trackers."""
from __future__ import annotations

from typing import Any

from homeassistant.components.device_tracker import SourceType, TrackerEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import slugify

from .const import CONF_VEHICLE_SLOTS, DEFAULT_VEHICLE_SLOTS, DOMAIN
from .coordinator import GTFSUpdateCoordinator
from homeassistant.const import MATCH_ALL

async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up fixed vehicle tracker slots for a GTFS route."""
    if config_entry.data.get("device_tracker_id"):
        return

    coordinator: GTFSUpdateCoordinator = hass.data[DOMAIN][config_entry.entry_id][
        "coordinator"
    ]
    await coordinator.async_config_entry_first_refresh()
    if not config_entry.options.get("vehicle_position_url"):
        return
    vehicle_slots = config_entry.options.get(
        CONF_VEHICLE_SLOTS, DEFAULT_VEHICLE_SLOTS
    )
    if vehicle_slots <= 0:
        return

    async_add_entities(
        [
            GTFSVehicleTracker(coordinator, slot)
            for slot in range(1, vehicle_slots + 1)
        ],
        False,
    )


class GTFSVehicleTracker(CoordinatorEntity, TrackerEntity):
    """A stable map entity representing one vehicle slot on a route."""
    _unrecorded_attributes = frozenset({MATCH_ALL})
    _attr_source_type = SourceType.GPS

    def __init__(self, coordinator: GTFSUpdateCoordinator, slot: int) -> None:
        """Initialize a vehicle slot."""
        super().__init__(coordinator)
        self._slot = slot
        route_name = coordinator.data["name"]
        object_id = f"gtfs_{slugify(route_name)}_{slot}"
        self._attr_unique_id = object_id
        self._attr_suggested_object_id = object_id
        self._attr_name = f"{route_name} {slot}"
        self._attr_icon = "mdi:train"
        self._attr_device_info = DeviceInfo(
            name=f"GTFS - {route_name} Vehicles",
            entry_type=DeviceEntryType.SERVICE,
            identifiers={(DOMAIN, f"GTFS - {route_name} Vehicles")},
            manufacturer="GTFS",
            model=f"{route_name} Vehicles",
        )
        self._update_position()

    @callback
    def _handle_coordinator_update(self) -> None:
        """Update the slot when vehicle data changes."""
        self._update_position()
        super()._handle_coordinator_update()

    def _update_position(self) -> None:
        """Apply the assigned vehicle position or mark the slot unavailable."""
        vehicles: list[dict[str, Any]] = self.coordinator.data.get("vehicles", [])
        vehicle = vehicles[self._slot - 1] if len(vehicles) >= self._slot else None
        if vehicle is None:
            self._attr_available = False
            self._attr_latitude = None
            self._attr_longitude = None
            self._attr_extra_state_attributes = {}
            return

        self._attr_available = True
        self._attr_latitude = vehicle["latitude"]
        self._attr_longitude = vehicle["longitude"]
        self._attr_extra_state_attributes = {
            key: value
            for key, value in vehicle.items()
            if key not in {"latitude", "longitude"}
        }
