# Presence Tracker GUI for Raspberry Pi

A dedicated GUI application for displaying real-time check-in status of users in the Presence Tracker system.

## Features

- **True Real-time Updates**: Uses Convex's official Rust client with WebSocket subscriptions - no polling!
- **Automatic Live Sync**: Updates instantly when anyone checks in or out via Convex's reactive sync engine
- **Check-in Display**: Shows only currently checked-in users (no clutter from absent users)
- **Check-in Details**: Displays check-in time (e.g., "5m ago") and method (App, Bluetooth, or Both)
- **Connection Status**: Live connection indicator showing WebSocket status
- **Clean Interface**: Modern, card-based UI with green indicators for checked-in users
- **Raspberry Pi Optimized**: Designed to run on Raspberry Pi with GUI support

## Prerequisites

1. **Rust Installation**:
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source ~/.cargo/env
   ```

2. **GUI Libraries** (for Raspberry Pi):
   ```bash
   # On Raspberry Pi OS with desktop
   sudo apt update
   sudo apt install libegl1-mesa-dev libgl1-mesa-dev libx11-dev libfontconfig1-dev
   ```

3. **Environment Setup**:
   Create a `.env` file in the `rust-agent` directory:
   ```env
   CONVEX_URL=https://your-convex-deployment.convex.cloud
   ```

## Building and Running

1. **Build the application**:
   ```bash
   cd rust-agent
   cargo build --release
   ```

2. **Run the GUI**:
   ```bash
   # Using the compiled binary
   ./target/release/presence-tracker-rs --gui

   # Or run directly with cargo
   cargo run -- --gui
   ```

## Usage

### Command Line Options

- `--gui` or `-g`: Run the GUI application (default mode)
- `--agent` or `-a`: Run the Bluetooth agent (for future integration)
- `--help`: Show all available options

### GUI Controls

1. **Menu Bar**:
   - **File Menu**: 
     - Quit: Exit the application
   - **Connection Status**: WebSocket connection state
     - 🟢 Green "Live": Connected via WebSocket, receiving real-time updates
     - 🟡 Yellow "Subscribing...": Establishing WebSocket subscription
     - 🔴 Red: Connection error or disconnected

2. **Status Bar**:
   - Shows last update time (updates automatically via WebSocket)
   - Displays count of currently checked-in users

3. **User Cards**:
   - 🟢 Green card background for each checked-in user
   - User name displayed prominently
   - ⏰ Check-in time (e.g., "Checked in 5m ago")
   - Method indicator:
     - 📱 App: Checked in via mobile app
     - 📡 Bluetooth: Checked in via Bluetooth detection
     - 📱+📡 App & Bluetooth: Verified by both methods

## API Integration

The GUI uses the official **Convex Rust Client** with WebSocket connections:

- **Reactive Subscriptions**: Subscribes to `devices:getCheckedInUsers` query via WebSocket
- **Real-time Sync**: Convex's sync engine automatically pushes updates when data changes
- **No Polling**: WebSocket connection stays open for true real-time updates

The application expects the `CONVEX_URL` environment variable to be set (loaded from `.env` file).

## Troubleshooting

### Common Issues

1. **GUI doesn't start**:
   - Ensure you have GUI libraries installed
   - Check if you're running in a graphical environment
   - Verify Rust and cargo are properly installed

2. **No users displayed**:
   - Verify users are actually checked in (not just registered)
   - Check the `CONVEX_URL` environment variable
   - Verify network connectivity to the Convex deployment
   - Ensure the `getCheckedInUsers` query is deployed in Convex

3. **Connection errors**:
   - Verify the Convex URL is correct
   - Check network connectivity
   - Ensure the Convex deployment is running

### Debug Mode

To see debug output, run with environment variable:
```bash
RUST_LOG=debug cargo run -- --gui
```

## Development

### Project Structure

```
rust-agent/
├── src/
│   ├── main.rs           # Entry point and CLI handling
│   ├── gui_simple.rs     # GUI implementation
│   ├── bluetooth_agent.rs # Bluetooth agent (existing)
│   └── bluetooth_probe.rs # Bluetooth utilities (existing)
├── Cargo.toml           # Dependencies
└── README_GUI.md        # This file
```

### Dependencies

- `convex`: Official Convex Rust client with WebSocket support
- `eframe`: GUI framework (v0.29)
- `egui`: Immediate mode GUI library (v0.29)
- `serde`: JSON serialization/deserialization
- `tokio`: Async runtime with time and sync features
- `dotenvy`: Environment variable loading

### How It Works

1. **WebSocket Connection**: The Convex Rust client establishes a WebSocket connection to Convex
2. **Reactive Subscription**: Subscribes to the `getCheckedInUsers` query via `client.subscribe()`
3. **Automatic Updates**: Convex's sync engine pushes updates instantly when:
   - A user checks in (appears on screen)
   - A user checks out (disappears from screen)
   - Check-in details change
4. **No Polling**: The WebSocket stays open, receiving updates only when data changes

## Future Enhancements

- [ ] User search functionality
- [ ] Historical attendance view
- [ ] Export capabilities
- [ ] System tray integration
- [ ] Desktop notifications for new check-ins
- [ ] Reconnection logic with exponential backoff

## License

This GUI is part of the Presence Tracker project. See the main project license for details.
