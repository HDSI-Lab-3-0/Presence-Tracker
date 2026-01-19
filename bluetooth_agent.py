#!/usr/bin/env python3
"""
Bluetooth Agent for IEEE Presence Tracker

This script runs a persistent Bluetooth agent that automatically accepts
pairing requests without requiring a PIN. It uses D-Bus to register as
the default Bluetooth agent and handles pairing, authorization, and
trust requests automatically.

Audio Routing Disabled:
This agent now rejects Bluetooth audio profile connections (A2DP, HSP, HFP)
to prevent audio output from being routed to the Raspberry Pi. Devices can
still pair and stay connected for presence tracking, but audio profiles
will not be established.
"""

import dbus
import dbus.service
import dbus.mainloop.glib
from gi.repository import GLib
import logging
import signal
import sys

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[
        logging.FileHandler("/home/ieee/Desktop/IEEE Presence Tracker/bluetooth_agent.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger(__name__)

# D-Bus object paths and interfaces
AGENT_INTERFACE = "org.bluez.Agent1"
AGENT_PATH = "/ieee/presence/tracker/agent"
BLUEZ_SERVICE = "org.bluez"
ADAPTER_INTERFACE = "org.bluez.Adapter1"
DEVICE_INTERFACE = "org.bluez.Device1"


class Rejected(dbus.DBusException):
    """Exception for rejected pairing requests."""
    _dbus_error_name = "org.bluez.Error.Rejected"


class BluetoothAgent(dbus.service.Object):
    """
    Bluetooth agent that automatically accepts pairing requests.
    
    This agent implements the org.bluez.Agent1 interface and responds
    to all pairing-related callbacks by accepting the request without
    user interaction.
    """

    def __init__(self, bus, path):
        super().__init__(bus, path)
        self.bus = bus
        logger.info(f"Bluetooth agent initialized at {path}")

    def _set_trusted(self, device_path):
        """Set a device as trusted after pairing."""
        try:
            device = dbus.Interface(
                self.bus.get_object(BLUEZ_SERVICE, device_path),
                "org.freedesktop.DBus.Properties"
            )
            device.Set(DEVICE_INTERFACE, "Trusted", True)
            logger.info(f"Device {device_path} marked as trusted")
        except Exception as e:
            logger.error(f"Error setting device as trusted: {e}")

    def _get_device_info(self, device_path):
        """Get device name and address for logging."""
        try:
            device = dbus.Interface(
                self.bus.get_object(BLUEZ_SERVICE, device_path),
                "org.freedesktop.DBus.Properties"
            )
            props = device.GetAll(DEVICE_INTERFACE)
            name = props.get("Name", "Unknown")
            address = props.get("Address", "Unknown")
            return f"{name} ({address})"
        except Exception as e:
            logger.error(f"Error getting device info: {e}")
            return device_path

    @dbus.service.method(AGENT_INTERFACE, in_signature="", out_signature="")
    def Release(self):
        """Called when the agent is unregistered."""
        logger.info("Agent released")

    @dbus.service.method(AGENT_INTERFACE, in_signature="os", out_signature="")
    def AuthorizeService(self, device, uuid):
        """Authorize a service connection request."""
        device_info = self._get_device_info(device)
        logger.info(f"AuthorizeService: {device_info} UUID: {uuid}")
        
        # DISABLED: Bluetooth audio routing to prevent audio output to Pi
        # Audio profile UUIDs to reject:
        # A2DP (Advanced Audio Distribution Profile): 0000110d-0000-1000-8000-00805f9b34fb
        # HSP (Headset Profile): 00001108-0000-1000-8000-00805f9b34fb
        # HFP (Hands-Free Profile): 0000111e-0000-1000-8000-00805f9b34fb
        # HFP AG (Hands-Free Audio Gateway): 0000111f-0000-1000-8000-00805f9b34fb
        audio_uuids = [
            "0000110d-0000-1000-8000-00805f9b34fb",  # A2DP
            "00001108-0000-1000-8000-00805f9b34fb",  # HSP
            "0000111e-0000-1000-8000-00805f9b34fb",  # HFP
            "0000111f-0000-1000-8000-00805f9b34fb",  # HFP AG
        ]
        
        if uuid in audio_uuids:
            # Reject audio profiles to prevent audio routing to Pi
            logger.info(f"Rejecting audio service request: {uuid} for {device_info}")
            raise Rejected("Audio profile connection rejected")
        
        # Ensure the device is paired and trusted for non-audio services
        self._ensure_paired_and_trusted(device)
        
        # Accept all non-audio service authorizations
        return
    
    def _ensure_paired_and_trusted(self, device_path):
        """Ensure a device is paired and trusted for persistent connection."""
        try:
            device = dbus.Interface(
                self.bus.get_object(BLUEZ_SERVICE, device_path),
                "org.freedesktop.DBus.Properties"
            )
            device_iface = dbus.Interface(
                self.bus.get_object(BLUEZ_SERVICE, device_path),
                DEVICE_INTERFACE
            )
            
            props = device.GetAll(DEVICE_INTERFACE)
            name = props.get("Name", "Unknown")
            address = props.get("Address", "Unknown")
            is_paired = props.get("Paired", False)
            is_trusted = props.get("Trusted", False)
            
            logger.info(f"Device {name} ({address}): Paired={is_paired}, Trusted={is_trusted}")
            
            # If not paired, initiate pairing
            if not is_paired:
                logger.info(f"Initiating pairing with {name} ({address})...")
                try:
                    device_iface.Pair()
                    logger.info(f"Pairing initiated with {name} ({address})")
                except dbus.exceptions.DBusException as e:
                    # "Already Exists" means device is already paired
                    if "Already Exists" in str(e) or "AlreadyExists" in str(e):
                        logger.info(f"Device {name} ({address}) is already paired")
                    elif "InProgress" in str(e):
                        logger.info(f"Pairing already in progress for {name} ({address})")
                    else:
                        logger.warning(f"Pairing failed for {name} ({address}): {e}")
            
            # Set trusted if not already
            if not is_trusted:
                device.Set(DEVICE_INTERFACE, "Trusted", True)
                logger.info(f"Device {name} ({address}) marked as trusted")
                
        except Exception as e:
            logger.error(f"Error ensuring device is paired/trusted: {e}")

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="s")
    def RequestPinCode(self, device):
        """Request a PIN code for pairing."""
        device_info = self._get_device_info(device)
        logger.info(f"RequestPinCode: {device_info}")
        # Return empty PIN for NoInputNoOutput capability
        return ""

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="u")
    def RequestPasskey(self, device):
        """Request a passkey for pairing."""
        device_info = self._get_device_info(device)
        logger.info(f"RequestPasskey: {device_info}")
        # Return 0 for NoInputNoOutput capability
        return dbus.UInt32(0)

    @dbus.service.method(AGENT_INTERFACE, in_signature="ouq", out_signature="")
    def DisplayPasskey(self, device, passkey, entered):
        """Display a passkey during pairing."""
        device_info = self._get_device_info(device)
        logger.info(f"DisplayPasskey: {device_info} Passkey: {passkey:06d} Entered: {entered}")

    @dbus.service.method(AGENT_INTERFACE, in_signature="os", out_signature="")
    def DisplayPinCode(self, device, pincode):
        """Display a PIN code during pairing."""
        device_info = self._get_device_info(device)
        logger.info(f"DisplayPinCode: {device_info} PIN: {pincode}")

    @dbus.service.method(AGENT_INTERFACE, in_signature="ou", out_signature="")
    def RequestConfirmation(self, device, passkey):
        """Confirm a passkey during pairing."""
        device_info = self._get_device_info(device)
        logger.info(f"RequestConfirmation: {device_info} Passkey: {passkey:06d}")
        # Auto-confirm all pairing requests
        self._set_trusted(device)
        logger.info(f"Pairing confirmed for {device_info}")
        return

    @dbus.service.method(AGENT_INTERFACE, in_signature="o", out_signature="")
    def RequestAuthorization(self, device):
        """Authorize a pairing request."""
        device_info = self._get_device_info(device)
        logger.info(f"RequestAuthorization: {device_info}")
        # Auto-authorize all pairing requests
        self._set_trusted(device)
        logger.info(f"Authorization granted for {device_info}")
        return

    @dbus.service.method(AGENT_INTERFACE, in_signature="", out_signature="")
    def Cancel(self):
        """Cancel a pending pairing operation."""
        logger.info("Pairing cancelled")


def get_adapter_path(bus):
    """Get the path of the first available Bluetooth adapter."""
    manager = dbus.Interface(
        bus.get_object(BLUEZ_SERVICE, "/"),
        "org.freedesktop.DBus.ObjectManager"
    )
    
    objects = manager.GetManagedObjects()
    for path, interfaces in objects.items():
        if ADAPTER_INTERFACE in interfaces:
            return path
    
    return None


def configure_adapter(bus, adapter_path):
    """Configure the Bluetooth adapter for pairing."""
    try:
        adapter = dbus.Interface(
            bus.get_object(BLUEZ_SERVICE, adapter_path),
            "org.freedesktop.DBus.Properties"
        )
        
        # Set adapter properties
        adapter.Set(ADAPTER_INTERFACE, "Powered", True)
        adapter.Set(ADAPTER_INTERFACE, "Discoverable", True)
        adapter.Set(ADAPTER_INTERFACE, "DiscoverableTimeout", dbus.UInt32(0))  # Never timeout
        adapter.Set(ADAPTER_INTERFACE, "Pairable", True)
        adapter.Set(ADAPTER_INTERFACE, "PairableTimeout", dbus.UInt32(0))  # Never timeout
        
        logger.info(f"Adapter {adapter_path} configured for discoverable/pairable mode")
    except Exception as e:
        logger.error(f"Error configuring adapter: {e}")


def register_agent(bus, agent_path, capability="NoInputNoOutput"):
    """Register the agent with BlueZ."""
    manager = dbus.Interface(
        bus.get_object(BLUEZ_SERVICE, "/org/bluez"),
        "org.bluez.AgentManager1"
    )
    
    manager.RegisterAgent(agent_path, capability)
    manager.RequestDefaultAgent(agent_path)
    logger.info(f"Agent registered with capability: {capability}")


def unregister_agent(bus, agent_path):
    """Unregister the agent from BlueZ."""
    try:
        manager = dbus.Interface(
            bus.get_object(BLUEZ_SERVICE, "/org/bluez"),
            "org.bluez.AgentManager1"
        )
        manager.UnregisterAgent(agent_path)
        logger.info("Agent unregistered")
    except Exception as e:
        logger.error(f"Error unregistering agent: {e}")


def signal_handler(signum, frame):
    """Handle termination signals."""
    logger.info(f"Received signal {signum}, shutting down...")
    mainloop.quit()


def main():
    """Main entry point for the Bluetooth agent."""
    global mainloop
    
    logger.info("Starting IEEE Presence Tracker Bluetooth Agent")
    
    # Initialize D-Bus main loop
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    
    # Get the system bus
    bus = dbus.SystemBus()
    
    # Find the Bluetooth adapter
    adapter_path = get_adapter_path(bus)
    if not adapter_path:
        logger.error("No Bluetooth adapter found!")
        sys.exit(1)
    
    logger.info(f"Found Bluetooth adapter: {adapter_path}")
    
    # Configure the adapter
    configure_adapter(bus, adapter_path)
    
    # Create and register the agent
    agent = BluetoothAgent(bus, AGENT_PATH)
    register_agent(bus, AGENT_PATH)
    
    # Set up signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    logger.info("Bluetooth agent is running. Waiting for pairing requests...")
    logger.info("Press Ctrl+C to stop.")
    
    # Run the main loop
    mainloop = GLib.MainLoop()
    
    try:
        mainloop.run()
    except KeyboardInterrupt:
        pass
    finally:
        unregister_agent(bus, AGENT_PATH)
        logger.info("Bluetooth agent stopped")


if __name__ == "__main__":
    main()
