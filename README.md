# Camera Mode Toggle Macro

This macro adds camera mode selection buttons to Cisco RoomOS and MTRoA devices, letting users switch between Speaker Track, Presenter Track, and Manual camera control without digging through settings menus. The buttons appear on the home screen, in the in-call control bar, and in the Control Panel side flyout.

![Control Panel Screenshot](/images/control-panel.png)

## Overview

The macro creates one button per camera mode:

- **Speaker Track** -- Activates automatic speaker tracking (camera follows the active speaker)
- **Presenter Track** -- Enables presenter following mode (only shown if configured on the device)
- **Manual** -- Deactivates automatic tracking and opens a PTZ (pan/tilt/zoom) controls page for direct camera adjustment

The active mode is indicated with a checkmark prefix on the button label (e.g. `✓ Speaker Track`).

### Where the buttons appear

- **RoomOS:** home screen, in-call control bar, AND Control Panel side flyout. All three surfaces stay in checkmark sync automatically.
- **MTRoA:** Control Panel side flyout only. The Microsoft Teams shell handles in-call extension panels inconsistently across call types (native Teams meetings vs. Webex CVI vs. SIP), so the side flyout is the universally reliable surface and the only one published. End-user instructions can be a single sentence: "open the Control Panel."

### Mid-call custom controls (RoomOS only)

During a call on a RoomOS device, the macro replaces three of the native mid-call controls with custom equivalents:

- **Mute Video / Unmute Video**
- **Raise Hand / Lower Hand**
- **Record / Stop Recording**

Each replica appears only when the active call supports the corresponding feature. A P2P SIP call shows the Mute Video replica only; a Webex meeting with recording permission shows all three. The native controls are restored automatically when the call ends.

The macro reconciles native-control visibility on every call connect, so transitioning between back-to-back calls with different capabilities works cleanly without bouncing the call. If the macro is reloaded mid-call (development cycle or unexpected restart), it re-binds to the active call and recovers state on its own; native controls are never left stuck in a hidden state.

This pipeline is skipped entirely on MTRoA because the xStatus paths used to detect feature availability are not reliably populated during Microsoft Teams Rooms calls.

### Key Features

- **RoomOS and MTRoA support** -- Auto-detects the device platform and adapts surface selection, native-control management, and selfview behavior accordingly.
- **Device state tracking** -- Camera status is monitored in real time. Mode changes from settings menus or other integrations update the buttons automatically.
- **Automatic Presenter Track detection** -- If Presenter Track is not configured, the option is hidden. Safe for fleet-wide deployment.
- **Multi-camera support** -- Detects PTZ-capable cameras and routes to the correct physical input connector even when camera ID and connector ID don't match. A camera selector appears in the Manual page when multiple PTZ cameras are present.
- **Video source switching** -- Mode changes set the correct video input connector for Speaker Track and Presenter Track on multi-camera systems.
- **Camera selector sync** -- Listens for external video source changes and keeps the camera selector widget in sync.
- **Respects current state on startup** -- Reads the device's current camera mode and video source at startup; does not force a default.
- **Selfview on PTZ interaction (RoomOS only)** -- A picture-in-picture selfview appears when using the PTZ pad and auto-dismisses after a configurable timeout. Skipped on MTRoA where the Teams UI provides its own.
- **Mid-call resilience** -- Survives macro reloads and crashes mid-call without leaving native controls stuck hidden. Reconciles cleanly across back-to-back calls with different capabilities.
- **Stale panel cleanup on startup** -- Removes panels left over from earlier macro versions automatically. No pre-flight cleanup is required when upgrading.
- **Custom icons** -- Replica panels can use built-in RoomOS icons or PNG icons embedded in the macro source. State-aware variants are supported (e.g. red record icon while a meeting is being recorded).
- **Startup diagnostics** -- Optional log of the device environment (tracking status, PTZ cameras, selfview availability) for troubleshooting.

### Camera Modes and xAPI Commands

| Mode | xAPI Command | Video Source | Description |
|------|-------------|-------------|-------------|
| Speaker Track | `Cameras.SpeakerTrack.Activate` | `SpeakerTrack.ActiveConnector` | Camera follows the active speaker |
| Presenter Track | `Cameras.PresenterTrack.Set Mode: Follow` | `PresenterTrack.Connector` (config) | Camera follows the presenter (requires configuration) |
| Manual | `Cameras.SpeakerTrack.Deactivate` | No change | Automatic tracking disabled, manual PTZ control |

## Configuration

Settings can be adjusted in the `config` object at the top of `camera-mode-toggle.js`. Most commonly changed:

```javascript
const config = {
  defaultMode: 'speakerTrack',       // Mode applied when a new call connects
                                     // (only used when newCallApplyDefault is true)
  newCallApplyDefault: false,        // Re-apply default mode when joining a new call
  cameraId: 0,                       // 0 = auto-detect first PTZ camera
  selfviewTimeout: 5000,             // Selfview auto-dismiss delay, ms (RoomOS only)

  icons: {                           // Camera mode button icons
    speakerTrack: 'Helpdesk',
    presenterTrack: 'Laptop',
    manual: 'Camera'
  },

  customReplicas: {                  // Mid-call replicas (RoomOS only)
    videoMute: { enabled: true, icon: 'custom:videoMute' },
    raiseHand: { enabled: true, icon: 'custom:raiseHand' },
    record:    { enabled: true, icon: 'custom:record'    }
  },

  publishToControlPanel: true,       // Dual-publish camera mode buttons to the
                                     // Control Panel side flyout on RoomOS.
                                     // Always treated as true on MTRoA.

  diagnostics: true,                 // Log device capability details at startup
  debugXml: false,                   // Log full panel XML payloads (verbose)
  trustNativeHiddenAtStartup: false  // Leave false unless the device admin has
                                     // intentionally configured a native mid-call
                                     // control to be permanently Hidden outside
                                     // of this macro
};
```

Each `customReplicas.*.enabled` flag can be toggled independently. Setting one to `false` suppresses both the replica panel AND the corresponding native-control hiding for that feature, so the native button reappears in-call.

## Compatibility

### Supported

- **Webex-registered devices** running RoomOS 11.x or above (cloud or on-prem registered)
- **Microsoft Teams Rooms on Android (MTRoA)** -- auto-detected. Camera mode buttons publish to the Control Panel side flyout only; mid-call replicas are skipped (see "Mid-call custom controls" above).
- **Webex meetings via CVI / WebRTC** on RoomOS devices, with full mid-call replica support.
- **P2P SIP calls** on RoomOS devices, with the Mute Video replica only (Raise Hand / Record are not exposed by SIP).

### Multi-Camera Devices

On devices with multiple cameras (e.g., Room Kit Pro with a speaker tracking camera and a separate presenter camera on different connectors), the macro automatically switches the video input source when changing modes. When multiple PTZ cameras are detected, a camera selector row appears in the Manual controls page. Camera ID and physical connector ID are mapped explicitly, so multi-camera setups where the two are not in the same order still route correctly.

## Setup

### Prerequisites

- Cisco device with RoomOS 11.x or above (cloud or on-prem registered)
- Web admin access to the device to upload the macro
- For Presenter Track mode: Presenter Track must be configured on the device (see [Set up PresenterTrack](https://help.webex.com/en-us/article/9ur0g6/Set-Up-PresenterTrack-for-Room-Devices))

### Installation

1. Download `camera-mode-toggle.js` and upload it to your device's Macro editor via the web interface.
2. Optionally adjust the `config` settings at the top of the file.
3. Enable the macro.

The macro auto-detects the device environment, removes any stale panels from prior versions, builds the appropriate UI for the platform, and syncs to the current camera state. **No pre-flight cleanup is required when upgrading from a previous version** -- the startup sweep handles legacy panel IDs automatically.

## Cleanup Utility

A companion macro, `camera-mode-toggle-cleanup.js`, is included for cases where you want to fully remove the main macro's panels and reset the native control configurations to their defaults. Typical uses:

- **Full uninstall** -- wipe all panels and restore native controls to `Auto` before removing the main macro.
- **Lab / development cycling** -- guarantee a known-clean state between test builds.
- **Recovery from unexpected state** -- a defensive reset if the device's UI or native controls end up in an inconsistent state for any reason.

The cleanup utility is **not required when upgrading** the main macro between versions.

### Using the cleanup utility

1. Disable `camera-mode-toggle.js` in the macro editor (so it does not immediately re-create its panels).
2. Upload `camera-mode-toggle-cleanup.js` if not already present.
3. Enable it.
4. Watch the macro console for `[cleanup]` log lines and the final summary.
5. Disable the cleanup macro.
6. Re-enable `camera-mode-toggle.js` (or remove it entirely for a full uninstall).

The cleanup runs once on macro start and then idles. To re-run, disable and re-enable the cleanup macro.

## Demo

*For more demos & PoCs like this, check out our [Webex Labs site](https://collabtoolbox.cisco.com/webex-labs).

## License

All contents are licensed under the MIT license. Please see [license](LICENSE) for details.


## Disclaimer

Everything included is for demo and Proof of Concept purposes only. Use of the site is solely at your own risk. This site may contain links to third party content, which we do not warrant, endorse, or assume liability for. These demos are for Cisco Webex use cases, but are not Official Cisco Webex Branded demos.


## Questions
Please contact the WXSD team at [wxsd@external.cisco.com](mailto:wxsd@external.cisco.com?subject=Camera-Mode-Toggle-Macro) for questions. Or, if you're a Cisco internal employee, reach out to us on the Webex App via our bot (globalexpert@webex.bot). In the "Engagement Type" field, choose the "API/SDK Proof of Concept Integration Development" option to make sure you reach our team.
