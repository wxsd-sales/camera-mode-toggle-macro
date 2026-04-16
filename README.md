# Camera Mode Toggle Macro

This macro places camera mode selection buttons directly in the **Control Panel** on Cisco RoomOS and MTRoA devices, letting users switch between Speaker Track, Presenter Track, and Manual camera control without navigating through settings menus.

![Control Panel Screenshot](/images/control-panel.png)

## Overview

The macro creates individual buttons in the Control Panel -- one per camera mode:

- **Speaker Track** -- Activates automatic speaker tracking (camera follows the active speaker)
- **Presenter Track** -- Enables presenter following mode (only shown if configured on the device)
- **Manual** -- Deactivates all automatic tracking and opens a PTZ (pan/tilt/zoom) controls page for direct camera adjustment

The active mode is indicated with a checkmark prefix on the button label (e.g. `✓ Speaker Track`).

### Key Features

- **RoomOS and MTRoA support** -- Auto-detects whether the device is running native RoomOS or Microsoft Teams Rooms on Android and adapts call detection and selfview behavior accordingly.
- **Device state tracking** -- The macro monitors actual camera status in real time. If the device changes modes on its own (e.g., via settings menu or another integration), the buttons automatically update to match.
- **Video source switching** -- When switching modes, the macro automatically sets the correct video input connector for Speaker Track and Presenter Track, ensuring the video feed follows the selected mode on multi-camera systems.
- **Camera selector sync** -- Listens for external video source changes and keeps the camera selector widget in sync, even when changes originate outside the macro.
- **Respects current state on startup** -- Reads the device's current camera mode and video source at startup and reflects them in the UI without forcing a default.
- **Automatic Presenter Track detection** -- Checks whether Presenter Track is configured at startup. If unavailable, the option is hidden. Safe for fleet-wide deployment.
- **PTZ camera auto-detection** -- Queries connected cameras for PTZ capabilities instead of requiring a hardcoded camera ID. If multiple PTZ cameras are detected, a camera selector appears in the Manual controls page.
- **Selfview on PTZ interaction (RoomOS only)** -- A picture-in-picture selfview appears when using the PTZ controls and auto-dismisses after a configurable timeout. Skipped on MTRoA where the Teams UI provides its own always-on selfview.
- **Startup diagnostics** -- Optionally logs a snapshot of the device environment (tracking status, PTZ cameras, selfview availability, Teams call state) for troubleshooting.

### Camera Modes and xAPI Commands

| Mode | xAPI Command | Video Source | Description |
|------|-------------|-------------|-------------|
| Speaker Track | `Cameras.SpeakerTrack.Activate` | `SpeakerTrack.ActiveConnector` | Camera automatically follows the active speaker |
| Presenter Track | `Cameras.PresenterTrack.Set Mode: Follow` | `PresenterTrack.Connector` (config) | Camera follows the presenter (requires configuration) |
| Manual | `Cameras.SpeakerTrack.Deactivate` | No change | All automatic tracking disabled, manual PTZ control |

## Configuration

Settings can be adjusted in the `config` object at the top of `camera-mode-toggle.js`:

```javascript
const config = {
  defaultMode: 'speakerTrack',      // Mode applied when a new call connects
                                    // (only used when newCallApplyDefault is true)
                                    // Options: 'speakerTrack', 'presenterTrack', 'manual'
  newCallApplyDefault: false,       // Re-apply default mode when joining a new call.
                                    // Set to false to keep the user's pre-call selection.
  cameraId: 0,                      // Set to a specific camera ID, or 0 to auto-detect
                                    // the first PTZ-capable camera.
  selfviewTimeout: 5000,            // Selfview auto-dismiss delay in ms (RoomOS only).
  icons: {                          // Icon per mode button
    speakerTrack: 'Helpdesk',
    presenterTrack: 'Laptop',
    manual: 'Camera'
  },
  diagnostics: true                 // Log device capability details at startup.
                                    // Set to false to reduce console output in production.
};
```

## Compatibility

### Supported

- **Webex-registered devices** running native RoomOS 11.x or above (cloud or on-prem registered)
- **MTRoA devices** -- The macro auto-detects Microsoft Teams Rooms on Android mode and adapts accordingly. Call detection uses `MicrosoftTeams.Calling.InCall`, and selfview commands are skipped since the Teams UI provides its own.
- **Teams meetings via CVI/WebRTC** -- The macro works normally during Microsoft Teams meetings joined from a Webex-registered device.

### Multi-Camera Devices

On devices with multiple cameras (e.g., Room Kit Pro with a speaker tracking camera and a separate presenter camera on different connectors), the macro automatically switches the video input source when changing modes. When multiple PTZ cameras are detected, a camera selector row appears in the Manual controls page.

## Setup

### Prerequisites & Dependencies

- Cisco device with RoomOS 11.x or above (cloud or on-prem registered)
- Web admin access to the device to upload the macro
- For Presenter Track mode: Presenter Track must be configured on the device (see [Set up PresenterTrack](https://help.webex.com/en-us/article/9ur0g6/Set-Up-PresenterTrack-for-Room-Devices))

### Installation Steps

1. Download the `camera-mode-toggle.js` file and upload it to your device's Macro editor via the web interface.
2. Optionally adjust the `config` settings at the top of the file.
3. Enable the macro in the editor.

The macro will auto-detect the device environment, build the Control Panel buttons, and sync to the current camera state.

## Demo

*For more demos & PoCs like this, check out our [Webex Labs site](https://collabtoolbox.cisco.com/webex-labs).

## License

All contents are licensed under the MIT license. Please see [license](LICENSE) for details.


## Disclaimer

Everything included is for demo and Proof of Concept purposes only. Use of the site is solely at your own risk. This site may contain links to third party content, which we do not warrant, endorse, or assume liability for. These demos are for Cisco Webex use cases, but are not Official Cisco Webex Branded demos.


## Questions
Please contact the WXSD team at [wxsd@external.cisco.com](mailto:wxsd@external.cisco.com?subject=Camera-Mode-Toggle-Macro) for questions. Or, if you're a Cisco internal employee, reach out to us on the Webex App via our bot (globalexpert@webex.bot). In the "Engagement Type" field, choose the "API/SDK Proof of Concept Integration Development" option to make sure you reach our team.
