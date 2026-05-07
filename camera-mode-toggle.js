/********************************************************
 *
 * Unified Camera Mode Buttons Macro
 * for Cisco RoomOS and MTRoA Devices
 *
 * Version: 2-0-0-dev
 * Released: in development (forked from v1.0.0 on 05/01/26)
 *
 * Places individual camera mode buttons directly in the
 * Control Panel. Speaker Track and Presenter Track are
 * single-tap action buttons. Manual opens a PTZ controls
 * page in one tap and activates manual mode automatically.
 *
 * The active mode is indicated with a checkmark prefix
 * on the button label.
 *
 * Presenter Track is only shown when configured on the
 * device, making this macro safe for fleet-wide deployment.
 *
 * Auto-detects RoomOS vs MTRoA and adapts call detection
 * and selfview behavior accordingly.
 *
 * --- v2 in-progress feature ---
 * On RoomOS devices, replaces the native Video Mute, Raise
 * Hand, and Record mid-call controls with custom panels that
 * only surface when the active call actually supports each
 * feature.
 *
 * Native-control hiding is bound to the call lifecycle:
 *   * baseline values for each managed config are captured
 *     at startup
 *   * each native config is set 'Hidden' only after a call
 *     connects AND its matching custom replica is about to
 *     be saved (strict per-replica)
 *   * each hidden config is restored to its captured
 *     baseline when the call ends
 * This keeps device behavior unchanged outside of calls
 * and survives macro removal cleanly between calls.
 *
 * On MTRoA devices, the entire native-hide + custom-replica
 * pipeline is skipped. Field testing showed that the
 * xStatus.Conference.Call[*].Capabilities.* paths used to
 * detect MidCallControls / VideoMute availability are
 * disabled during Webex CVI calls on MTR, making the probe
 * unreliable. Additionally, MTR camera mode buttons are
 * published EXCLUSIVELY to the ControlPanel side flyout
 * (HomeScreenAndCallControls is skipped). The Teams shell
 * on MTR varies its handling of HSCC panels by call type
 * and firmware, so dual-publishing on MTR would create a
 * disjointed UX -- buttons appearing in one call type but
 * not another. Side-flyout-only publication on MTR gives
 * users one universally reliable surface and makes
 * end-user instructions trivial: "open the Control Panel".
 *
 * The original v1 file (camera-mode-toggle.js) is preserved
 * unchanged in the repo while v2 is under development.
 *
 ********************************************************/

import xapi from 'xapi';

/*********************************************************
 * CONFIGURATION
 *
 * Edit these values to customize macro behavior.
 * Everything below this section should not need changes.
 *********************************************************/

const config = {
  defaultMode: 'speakerTrack',
  newCallApplyDefault: false,

  // Set to a specific camera ID, or 0 to auto-detect.
  cameraId: 0,

  // Selfview auto-dismiss delay in milliseconds (RoomOS only).
  selfviewTimeout: 5000,

  // Icon per mode button. Two formats accepted:
  //
  //   Built-in:  'Camera' (or any of: Briefing, Concierge, Helpdesk,
  //              Hvac, Info, Input, Language, Laptop, Lightbulb,
  //              MediaPlayer, Microphone, Moderator, Plus, Proximity,
  //              Record, Sliders, Spinner, Tv, Webex)
  //   Custom:    'custom:<key>'  -- looks up CUSTOM_ICONS[<key>] (populated
  //              by tools/embed-icons.js). Falls back to 'Camera' if the
  //              key is missing.
  //
  // Camera mode buttons have no active-state variant; the active mode is
  // signaled with a checkmark prefix in the label, not an icon swap.
  icons: {
    speakerTrack: 'Helpdesk',
    presenterTrack: 'Laptop',
    manual: 'Camera'
  },

  // Log device capability details at startup.
  diagnostics: true,

  // Phase 2 instrumentation. When true, logs comprehensive call context
  // data on every call connect / disconnect event so we can design the
  // production show/hide rules for the custom replica panels.
  // Purely observational: reads state only, never sets configs or invokes
  // commands. Safe to leave on while testing. Turn off in production.
  discoveryMode: false,

  // Custom replica panels that replace the native mid-call controls during
  // a call. Each replica is added on call connect ONLY if the active call
  // context exposes its capability (per Status.Conference.Call[*].Capabilities)
  // AND its enabled flag is true here. The associated native control is
  // hidden (and later restored) automatically based on which replicas
  // activate -- see NATIVE_CONFIG_REPLICAS below for the mapping.
  //
  // icon syntax: same as config.icons above. Use 'custom:<key>' to pull
  // from CUSTOM_ICONS. State-aware: when the underlying feature is in its
  // active state (recording, hand raised, video muted), the macro will
  // prefer CUSTOM_ICONS[<key>].active over CUSTOM_ICONS[<key>].default if
  // an active variant exists.
  //
  // Set enabled: false on any replica to suppress it AND leave its native
  // control alone for the lifetime of every call.
  customReplicas: {
    videoMute: { enabled: true, icon: 'custom:videoMute' },
    raiseHand: { enabled: true, icon: 'custom:raiseHand' },
    record:    { enabled: true, icon: 'custom:record'    }
  },

  // Dump the full XML body of every panel save call to the console. Useful
  // when reverse-engineering the exact format Cisco's UI Extensions parser
  // expects (e.g. comparing custom-icon variants against a working reference
  // exported from the web admin's UI Extensions Editor). Leave false in
  // production -- it's noisy and the base64 icon payloads make each line long.
  debugXml: true,

  // Dual-publish each camera mode button into the device's Control Panel
  // (the side flyout drawer) IN ADDITION TO the in-call / home-screen
  // surface.
  //
  // Why: a single panel can only live in ONE location. The default
  // HomeScreenAndCallControls placement covers home + in-call but loses
  // the v1 Control Panel access. With this true, every mode panel is also
  // saved as a twin in ControlPanel so the side flyout surface is
  // preserved on RoomOS. Both copies stay in checkmark sync automatically.
  //
  // Cost: each mode change writes two Panel.Save calls instead of one.
  // Set to false to drop the Control Panel twins entirely on RoomOS
  // (existing twins are pre-removed at startup via STALE_PANELS so they
  // don't linger).
  //
  // MTR override: this flag is force-treated as true on MTR devices.
  // On MTR the macro publishes EXCLUSIVELY to the ControlPanel side
  // flyout (HSCC is skipped because the Teams shell suppresses it
  // inconsistently). With this flag set to false on an MTR device the
  // macro will warn and override to true so users always have a
  // working surface. See buildAllPanels() for the full rationale.
  publishToControlPanel: true,

  // When false (default), the macro assumes that seeing a 'Hidden' value
  // for UserInterface.Features.Call.VideoMute or .MidCallControls at
  // startup is leftover state from a prior run of this macro that
  // reloaded / crashed before restoring natives. It will:
  //   * if no call is active: immediately set the affected configs back
  //     to 'Auto' AND record 'Auto' as the baseline for future teardowns.
  //   * if a call IS active: keep the on-device value as-is, but claim
  //     ownership (so teardown at call-end restores to 'Auto') and still
  //     record 'Auto' as the pre-macro baseline.
  //
  // Set this to true ONLY if a device admin has intentionally configured
  // either native control to be permanently Hidden via xConfiguration
  // outside of this macro. In that case the macro will treat the current
  // value as the baseline and not second-guess it. This reverts the
  // hardening and re-exposes the "macro reloaded mid-call -> natives
  // stuck Hidden forever" failure mode.
  trustNativeHiddenAtStartup: false
};

/*********************************************************
 * CONSTANTS AND STATE
 *********************************************************/

const MANUAL_PAGE_ID = 'camManualPage';
const CAM_SELECT_ID = 'camSelectBtn';
const PTZ_PAD_ID = 'camPTZPadBtn';
const ZOOM_IN_ID = 'camZoomInBtn';
const ZOOM_OUT_ID = 'camZoomOutBtn';

// Suffix appended to every panel / page / widget ID when we save the
// ControlPanel (side flyout) twin of a camera mode panel. RoomOS treats
// widget IDs as device-wide unique, so each twin needs its own copies
// of the page id and every interactive widget id inside it.
const CP_SUFFIX = 'CP';
const MANUAL_PAGE_ID_CP = MANUAL_PAGE_ID + CP_SUFFIX;
const CAM_SELECT_ID_CP = CAM_SELECT_ID + CP_SUFFIX;
const PTZ_PAD_ID_CP = PTZ_PAD_ID + CP_SUFFIX;
const ZOOM_IN_ID_CP = ZOOM_IN_ID + CP_SUFFIX;
const ZOOM_OUT_ID_CP = ZOOM_OUT_ID + CP_SUFFIX;

// Each entry in PANEL_LOCATIONS describes one surface where a camera-mode
// panel may be published. saveModeButton() iterates these (gated by
// config.publishToControlPanel for the CP entry) so that a single mode
// can exist in multiple surfaces with all event-handler plumbing pointed
// back to the same code paths via normalizeId().
const PANEL_LOCATIONS = {
  HSCC: {
    location: 'HomeScreenAndCallControls',
    panelSuffix: '',
    pageId: MANUAL_PAGE_ID,
    widgets: { camSelect: CAM_SELECT_ID, ptzPad: PTZ_PAD_ID, zoomIn: ZOOM_IN_ID, zoomOut: ZOOM_OUT_ID }
  },
  CP: {
    location: 'ControlPanel',
    panelSuffix: CP_SUFFIX,
    pageId: MANUAL_PAGE_ID_CP,
    widgets: { camSelect: CAM_SELECT_ID_CP, ptzPad: PTZ_PAD_ID_CP, zoomIn: ZOOM_IN_ID_CP, zoomOut: ZOOM_OUT_ID_CP }
  }
};

// Custom replica panel IDs (added in v2). Each is a pageless action button
// in CallControls location, added/removed dynamically with the call.
const REPLICA_VIDEO_MUTE_ID = 'cmtCustomVideoMute';
const REPLICA_HAND_ID = 'cmtCustomHand';
const REPLICA_RECORD_ID = 'cmtCustomRecord';

/*********************************************************
 * CUSTOM_ICONS
 *
 * Populated automatically by tools/embed-icons.js from PNG
 * files dropped in working/icons/. See working/icons/README.md
 * for the workflow.
 *
 * The block between BEGIN / END markers below is overwritten
 * on every script run -- DO NOT edit it by hand.
 *********************************************************/
// === BEGIN GENERATED CUSTOM_ICONS ===
// Generated by tools/embed-icons.js -- do NOT edit this block by hand.
// Run "node tools/embed-icons.js" to regenerate after changing PNGs in
// working/icons/.
//
// Schema:
//   CUSTOM_ICONS[<key>].default         -- always-shown icon variant
//   CUSTOM_ICONS[<key>].active          -- icon shown when the panel is
//                                          in its "active" state (e.g.
//                                          recording in progress)
// Each variant: { id: <md5 hex>, content: <base64 PNG> }
const CUSTOM_ICONS = {
  raiseHand: {
    default: {
      id: "013cdb98122b177cfce24dbee3ffc5fb5c29f5e3b4fcb3dc2a557ca81510b20c",
      content: "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"
    },
    active: {
      id: "547a8da197b06a8bdaf31234501e510cdeef1dd45e4cadf6865aa55d17cb5b5d",
      content: "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"
    },
  },
  record: {
    default: {
      id: "1847401d9014cea76ee7b1dfe1db28574cb2495decf7fca86d8026cc0a9401e0",
      content: "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"
    },
    active: {
      id: "e77d1b31c4978e4b02cecf0521ea6979547cb58e5943923dc9b85d0695182f63",
      content: "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"
    },
  },
  videoMute: {
    default: {
      id: "b70e64086724793142664db00f37f76bd1f076c5aa98f5bf9e79f727e44b662a",
      content: "iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAYAAAA5ZDbSAAAACXBIWXMAAAsTAAALEwEAmpwYAAAFXElEQVR42u2dW4hVVRjHj+aUSua1zMpwuolRPZhdoHszkVoiJgNalJbhQwQGgUrDqF3oIVIrsgtaBKWWoZEQSol0GSjtKtRDTwZZQRcju4harr7VrJEzZ87aZ+09e2h/a//+8H/Sc2Z967fP3mt9a+1vVSoIIYQQQgghhBBCCCGEEEIIIYQQQgihWGSMGSO+XNwqblPoGeLrxRPFTQA1Zoh4rnij+AcTl46IPxQ/LJ5UNrCjxY+IfzXl0bviG8oAd4H4F1NevSkeHyPYk8SbDTLuAr8pJriniD+Faw/9LV4YA9wR4i8CArbP4w3iDvFdSkfRc8SLxI8FXtBHxXdqhjtQ/HaDID9z04umCB9LZzrYBxuMtq/RGuDShMD+cr/UgSUYWFrQOxL64jvxKG1Bne0g+gKaUrKp4SDx0wmQn9MW0HpPIL+LLypxcmdtwqBropYgml2D62lmybN3J4h3efpmnZYgHvQEsJWM+3/9c4kbQdfqD/GJGgL4yjMluAC8x/pok+dHMLvoDR/nuTp3g7VHP03zAH6m6A2f7mn4A2Dt9Sw+UKefPurDd54mvkJ8rZ2a9VfDF3kAt4C1V1+9X6ef9mf4nhvdalXtnfMT8dS8G/2QB/D5IO3VV696xiqDUuT41wekQ5fn2eiVnj80BqS9+upJT18Nb/C5AeL54p9TLG7cnlejV3n+wMgcvvsc8b3iR8XLxDeLBysGvDJtX7k+2JFh9crumBlSSMDuVvS6Z3Ru0563xg7YpTqXJKR/QzSjcIDlc6eLvwlofHusgF1iJGTJ9U93Z3vK8+8dhQLsnjWdgVfnUW17nhoBtlkt8eqEtG+17LLsWe5zJ3v+z+qiAZ6e8ha0KxbALvaQO9dP4jvqbGpUAfjFDM+Z8REA3hoY68v21+rZtaoCcGcGwC0RAG6kvTa50WBbsgrAH2QI/rqIAf8jfr7RipMmwC+U9Bbt27t2cYoXCxhkKQFspz6LQ9OX2gAPSHGbttOk1sgAv2P3tmV8Naj4gKsSHXsDAKtbjkwAbHPM8+wF3od3v3QArkpVbkpIVc6JLFXZnMPLfXoA12zFvcctNnS4Z3SMiw0jSgm4Et9yIYABDGAAAxjAAAYwgAEMYAAjAAMYwAAGMIABDGAAAxjAAAYwgAEMYAADmC07ANYC2BZmXViaTXclBNyt97JUvwOwro3v9oXvFeLjARwn4G7tEV8G4HgBV798NgzAcb8+ajf7zwKwXsBvBIK2RyCMBbDOEg62HOHXJuysix5TKgDrKcIyVPy46TrXoZF2is+tJBdhWQXgYpZRmmzCTnGxU6r2hO9dAuBiF0K7370QnlXTAFz8Uob2uITtGeDuS1MlgGKk/2MxUvfZ28Q/pgA8m3LCxSknfFyKjNVLnhfjq5MjSykIrrsgeIurKVYLujP38o4JlXHaQdqjnwabrlNWTI4l/c8QX2W6TiEf118NP5VDOfr0Q1ijofFfep4tF4L2WB/5zlK+RUPjV3ga/xZo4zgYa0JCem0Wz16z29M3azUF8orhcMp6/bLO+A+nPE9TIM0J5wt8L760ZGCbxM8mzFfXaAxqcUJAB90yVxkOiJ7gNtD59K3KVK474n1bwF6jmWk2lSkD+4T4UEL8h8VXag5yuPjzgFzpby51t1y8QNym0HPF97mDNPYEVsidF8OVbBegPzaodlB1d0y3q2Hi1+Bquk9KmVqpxDngmO8CLKu22BrYsY8qR7pj4PeXCOxOTQeG5JnVaXPn/+yLDOght1y3TFUCo5+BjxJPEbcqHUXb01Cvtrsbc9kegxBCCCGEEEIIIYQQQgghhBBCCCGEEIpd/wKaZVqs+neluQAAAABJRU5ErkJggg=="
    },
    active: {
      id: "6ec264aaf332f38b577c6416727314254261506882886adfa4f472e02461c78e",
      content: "iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAYAAAA5ZDbSAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGc0lEQVR42u2dWYgcVRSG2+CG+0Jc0LglGOlJV1VPOTNd1T20S4JbxB3UPCgK+iIx4Eob90ejMaCID4oQH9QXgw/GKKKOCJkEFfVJX3yZiKgxqIkmxMn1VFVnoadubV3d1jn1/3AJJN2h7vnqVp17z+lzKhUIgiAIgiAIgiAIgiAIgiAIKqBU07xBNa1NwTBuhEXkwVU943FYRgxgf+WqOcO1noB1JAB2zY2hgAFZCOCWeb0WsD/M1bAS/8f0g5GQsZJLABmOl4T3sdWJW8nKMZbQY/sS5dZvUi3rFlajaVxL13+ZcmuLlW0fAciSh2vupblupvEswa8CsvhhfkZ/LgNk8Svbek9NjiwAZNlju2oZywFZ9jv6X3ps38sfoG0foxxrpapUDusD8hQTT/o2utb7Cd4amtOXCUDvI8/7Lr5wCSpN9N2uk7GuL8j07+zm79TPJdjP0fgn0tumbSHXSNJ9PZN5sWyQAzvY59D1fxzhYW9TjeopvCbVMM8iIDtD7thyQm63D6e5vxwxr1e5HU2+rrlb/1YT5nl9nnixhNyNrr2hmdescuyLeExivHY2XfAezUTuyOlYk+dKvnLRUXT905o5vcblLn1M41BszPnsmidkxxoLPOg589mp2tXjOAD+JhRIwxwfQICCJ2TXeid0Po51c8ED/Nb80LuzaW4ZYBSqwxDw1Rof5ZWiO1dXaS78qQGHGjsM38V/hsxlOvP/OWmfSQcnLVpkbdUeO2NQ75eVoQBa1tIhxJM7zHYaUyFz2JHe5sYV9L1P5j45KYLl1C/P+/37jAZwdUhJAx1GgN8KnQPtmVO8Dt+MOQ6dpfFonoDXaADPH2JmSIfJSd+6cMDmSbFHwLTdpO//lji4QWfled2Vz4d70PkexUmAnMVWyrUX0iL6KEPCwbakT4ZCAJYAOY2tukedDxOoXZlDlI55DSvA3CEntRUlIF5Mf/91glW6y09cdK214Y9p8xF2gDlDjrOVWmYc63/GTw6ITSD4ULVqF/jfo+9rPvcCS8Bc866jbBWkDps/JMjx+p1W5j2HRug8J03z2bVsAXNcyVpbNc0NCd+r68N2J2IBc1vJesCx40fvcEMfexYMmBPkDIBnvcSAuIiTeMBcIKcC7EXoEkbjSgGYA+RkgCkDhgI1qlo9Mnl6UEkAFx1yPGAKFtAP2dLnf5UIcJEha21FEaXerQ8AM9xCaW3VPbDInsFZQsBFXMmDslVpARcNMgALhwzAwiEDsHDIACwcMgALhwzAwiEDsHDIACwcMgALhwzAwiEDsHDIACwcMgALhwzAwiEDsHDIACwcMgDzrVzf6S8ny17YZ33QEwG4ACsZSXfCISfIi57KUv0OgAsCOVHiu1+pFonvLCGn/G3St6o52gBgRpAz//jMXXw8ADOAnP3no1RQJaJNLwAXZAvV9w/AXevtsIp22CYVZCVrbTU2dmpQwsH6PgHkHX6fiEplHlZwoVayX3JZC/hAQxO/wYfX1yHW2/6UWvVc6H+vVTtZXBEWpi2DZqIAHywyWhtN1MXF21L5ZZQ01QapzhYAF6EvVA/gA4XQmtYDfRVCo0rAAFwEyCGAD65m43z6zAcZ4M7kU8pwCMVIxUOOKUbatfMKGr8kB6zfVqWtoPq0xvUfqVTQPzlRy7tDPOLI/8/ztoMuLvsiD0fyKGE4jILgJfGuf83QRmEpLaAvQkBP5W73iJL+q4E3+RYqW0n/kQVUtGXS30MPrKT/xJLTNU05tgKtkFLIdIHfhXbabNUNoBUAmS7sSc2j531g5V8ld39b1b0Dddexkv/3O3O95mL/wqNawEr2Ooxqj9Vc8yc6GJ8oFUBKuaG53y6qtS6BfCjyYDzIHJwnHq53vOham8V1QvfgeY5VbJlc17ouTVIZrxbv1ks0dvdsGQVBHh8/gS7qqwRpKH/4GQqBB36318iJ3XDqt/rBd4q7ajuwioTst2Azt/YR5pI49njtcsR4114Zem2vvvKNn2mFXypyC0UTuzNdmEvY8BpDO8ZpovfJQc6QH1bcXiK4m7xAQLkOQ9rto72W5t1DkRlhK3U3jc+9KNr+ZLjSN+T0O361Rm0/vumBZ+dJG8v9UF2jviiX9JiStLuHJAQoIECG0meGrICVZEOehoUkQ6bjUlhHNGRzFSwjCjIlwzfNLUGgw1yVtYgLBEEQBEEQBEEQBEEQBEEQBA1S/wFairPEa/6sLAAAAABJRU5ErkJggg=="
    },
  },
};
// === END GENERATED CUSTOM_ICONS ===

// Explicit display order for our panels in the in-call control bar
// (and on the home screen for HomeScreenAndCallControls panels).
//
// Lower numbers appear first (leftmost). Camera mode panels are
// pinned to slots 1-3 so they stay visible inline; the custom
// replica panels get slots 4-6 so on devices with limited bar
// width they overflow to the More menu (matching the customer's
// target UX).
//
// IMPORTANT: every Panel.Save call MUST include this <Order> tag.
// Without it, RoomOS re-positions a re-saved panel to the end of
// the bar, which produces the visible reshuffle bug seen when a
// camera mode changes mid-call (mode panels get pushed to More
// while replicas creep into the inline slots).
const PANEL_ORDER = {
  speakerTrack: 1,
  presenterTrack: 2,
  manual: 3,
  replicaVideoMute: 4,
  replicaHand: 5,
  replicaRecord: 6
};

const STALE_PANELS = [
  // Old IDs from prior macro versions -- kept here so a clean reinstall
  // sweeps them away even if the user is upgrading from v0.x.
  'cameraModeToggle',
  'cameraModeToggleMTR',
  'cameraModeButtons',
  'camPTZPanel',
  // Dynamic v2 panels -- listed so a macro reload mid-call removes the
  // prior instance's panels before we recreate them.
  REPLICA_VIDEO_MUTE_ID,
  REPLICA_HAND_ID,
  REPLICA_RECORD_ID,
  // ControlPanel twins -- listed so toggling config.publishToControlPanel
  // off (or removing a previously available mode like Presenter Track)
  // removes the orphaned twin instead of leaving it in the Control Panel
  // side flyout.
  'camBtnSpeakerTrack' + CP_SUFFIX,
  'camBtnPresenterTrack' + CP_SUFFIX,
  'camBtnManual' + CP_SUFFIX
];

let availableModes = [];
let ptzCameras = [];
let activeCameraId = null;
let currentMode = null;
let callId = null;
let applyingMode = false;
let isMTR = false;
let selfviewTimer = null;
let lastCallApplyTime = 0;

// Custom replica state (v2).
//   activeReplicaCallId      -- id of the call the replicas are bound to,
//                               or null if no call is active.
//   replicaSettleTimer       -- per-call settle timer; replicas are saved
//                               ~1500ms after Connected so the conference
//                               capability tree has populated.
//   replicaSupport           -- last computed { videoMute, hand, record }
//                               support map for the active call.
//   originalNativeConfigs    -- map of UserInterface.Features.Call.<Name>
//                               values captured ONCE at macro startup.
//                               Used to restore each native control after
//                               a call ends so that macro removal between
//                               calls leaves device behavior unchanged.
//                               null entries mean the path is unsupported
//                               on this device build.
//   hidesAppliedNames        -- set of native config names this macro has
//                               actively set to 'Hidden' for the active
//                               call. Used to restore only what we touched.
let activeReplicaCallId = null;
let replicaSettleTimer = null;
let replicaSupport = { videoMute: false, hand: false, record: false };
let originalNativeConfigs = {};
let hidesAppliedNames = new Set();

// Defensively allow the Node test runner (Jest) to exit cleanly when only
// pending timers remain. On the RoomOS macro sandbox the timer handle
// returned by setTimeout has no `.unref` method, so the typeof-guard
// makes this a no-op on-device. Pass-through return so call sites stay
// concise: `myTimer = unrefTimer(setTimeout(...))`.
function unrefTimer(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/*********************************************************
 * INITIALIZATION
 *
 * Runs once when the macro starts. Detects the device
 * environment, discovers hardware capabilities, builds
 * the UI, syncs to the current camera state, and
 * registers all event listeners.
 *********************************************************/

init();

async function init() {
  console.log('=== Camera Mode Buttons (Unified): Starting ===');

  isMTR = await detectMTRMode();
  console.log('Device mode:', isMTR ? 'MTRoA' : 'RoomOS');

  await cleanupStalePanels();

  const ptAvailable = await checkPresenterTrack();

  availableModes = [
    { key: 'speakerTrack', name: 'Speaker Track', panelId: 'camBtnSpeakerTrack' }
  ];
  if (ptAvailable) {
    availableModes.push({ key: 'presenterTrack', name: 'Presenter Track', panelId: 'camBtnPresenterTrack' });
  }
  availableModes.push({ key: 'manual', name: 'Manual', panelId: 'camBtnManual' });

  console.log('Camera modes available:', availableModes.map(m => m.name).join(', '));

  ptzCameras = await detectPTZCameras();

  if (config.cameraId > 0) {
    activeCameraId = config.cameraId;
    if (!ptzCameras.some(c => c.id === config.cameraId)) {
      console.warn('Config cameraId', config.cameraId, 'not found in PTZ cameras; using it anyway');
    }
  } else if (ptzCameras.length > 0) {
    activeCameraId = ptzCameras[0].id;
  }

  if (activeCameraId) {
    console.log('Active PTZ camera:', activeCameraId);
  } else {
    console.warn('No PTZ-capable cameras detected; PTZ controls will be hidden');
  }

  // Native-hide + custom-replica pipeline is RoomOS-only. On MTR the
  // xStatus capability paths (Conference.Call[*].Capabilities.RaiseHand
  // / .Recording.Start) are not reliably populated during Webex CVI
  // calls, and the Teams shell owns the in-call UI for native Teams
  // meetings. Camera mode buttons remain dual-published to both HSCC
  // and ControlPanel surfaces so MTR users always reach them via the
  // side flyout regardless of call type.
  if (!isMTR) {
    await captureNativeControlsBaseline();
  } else {
    console.log('MTR mode: skipping native-control baseline capture (replica pipeline disabled on MTR)');
  }

  await buildAllPanels();
  await syncState();

  xapi.Event.UserInterface.Extensions.Panel.Clicked.on(handlePanelClicked);
  xapi.Event.UserInterface.Extensions.Widget.Action.on(processWidgetAction);
  xapi.Event.UserInterface.Extensions.Page.Action.on(handlePageAction);
  xapi.Status.Video.Input.MainVideoSource.on(value => setCameraSelectWidgetValue(value));

  registerStatusListeners(ptAvailable);
  registerCallListeners();

  if (!isMTR) {
    registerReplicaListeners();
  } else {
    console.log('MTR mode: skipping replica call-lifecycle listeners');
  }

  // Recovery step: if a call is already in progress at macro start (edit-
  // and-reload mid-call, runtime crash recovery, etc.), re-bind the
  // replica lifecycle to the existing call now. The baseline sanitizer
  // above has already repaired originalNativeConfigs for this scenario.
  // Skipped on MTR for the same reason the rest of the pipeline is.
  if (!isMTR) {
    await recoverActiveCallIfAny();
  }

  if (config.diagnostics) await runDiagnostics();

  if (config.discoveryMode) await initDiscoveryMode();

  console.log('=== Camera Mode Buttons (Unified): Ready ===');
}

/*********************************************************
 * DEVICE DISCOVERY
 *
 * Functions that probe the device once at startup to
 * determine what hardware and software features are
 * available.
 *********************************************************/

async function detectMTRMode() {
  // Probe by asking the Microsoft Teams app registry whether the MTR
  // platform is installed on this device. On MTRoA this resolves with
  // an Entry list containing 'MicrosoftTeamsRooms'; on plain RoomOS the
  // command rejects with a "No platforms found" error. This is the
  // canonical "is this an MTR device?" probe and is more reliable than
  // checking for the presence of the MicrosoftTeams.Calling.InCall
  // status path (which we used previously) -- that path's existence is
  // a side-effect of namespace population, not a documented detection
  // mechanism.
  return await xapi.Command.MicrosoftTeams.List({ Show: 'Installed' })
    .then(() => true)
    .catch(() => false);
}

async function checkPresenterTrack() {
  try {
    const enabled = await xapi.Config.Cameras.PresenterTrack.Enabled.get();
    const available = (enabled === 'True');
    console.log('PresenterTrack configured:', available);
    return available;
  } catch (e) {
    console.log('PresenterTrack not available on this device:', e.message);
    return false;
  }
}

// Attempt to get the camera id for the selected video input connector
async function getDetectedCameraId(connectorId) {
  console.log('Getting Camera Id for Connector:', connectorId)
  const results = await xapi.Status.Cameras.get();
  const cameras = results?.Camera;
  if (typeof cameras == 'undefined') return connectorId
  const camera = cameras.find(camera => camera?.DetectedConnector == connectorId)
  if (typeof camera == 'undefined') return connectorId
  return camera?.id ?? connectorId
}

async function detectPTZCameras() {
  try {
    const result = await xapi.Status.Cameras.get();
    const cameras = result?.Camera ?? [];
    const ptz = cameras
      .filter(c => c?.Capabilities?.Options?.includes('ptzf'))
      .map(c => ({
        id: parseInt(c.id),
        // DetectedConnector is the physical input the camera is wired
        // to; on most devices it equals the camera id, but Codec Pro /
        // multi-camera setups can expose them out-of-order. Capture it
        // explicitly so the manual selector widget can route to the
        // correct connector regardless of id ordering.
        connectorId: parseInt(c.DetectedConnector ?? c.id),
        name: (c.Manufacturer + ' ' + c.Model).trim()
      }));
    console.log('PTZ cameras found:', ptz.length > 0
      ? ptz.map(c => c.id + ' (' + c.name + ')').join(', ')
      : 'none');
    return ptz;
  } catch (e) {
    console.log('Could not query cameras:', e.message);
    return [];
  }
}

async function cleanupStalePanels() {
  for (const panelId of STALE_PANELS) {
    try {
      await xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: panelId });
      console.log('Removed stale panel:', panelId);
    } catch (e) {
      // Panel didn't exist -- expected
    }
  }

  // On MTR, also remove the HomeScreenAndCallControls camera-mode
  // publications. Current MTR builds publish exclusively to the
  // ControlPanel side flyout (see buildAllPanels), but a device that
  // ran a prior version of this macro may still have HSCC mode panels
  // saved on disk. Sweep them so the MTR experience is strictly
  // side-flyout-only and matches the user-facing instructions.
  if (isMTR) {
    const mtrStaleHscc = ['camBtnSpeakerTrack', 'camBtnPresenterTrack', 'camBtnManual'];
    for (const panelId of mtrStaleHscc) {
      try {
        await xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: panelId });
        console.log('Removed stale HSCC mode panel (MTR):', panelId);
      } catch (e) {
        // Not present -- expected on a fresh install
      }
    }
  }
}

/*********************************************************
 * STATE MANAGEMENT
 *
 * Keeps the macro's internal mode in sync with the
 * device's actual camera tracking state, and issues
 * xAPI commands when the user requests a mode change.
 *********************************************************/

async function syncState() {
  const selectedConnector = await xapi.Status.Video.Input.MainVideoSource.get()
  setCameraSelectWidgetValue(selectedConnector)
  try {
    const stStatus = await xapi.Status.Cameras.SpeakerTrack.Status.get();
    if (stStatus === 'Active') {
      setCurrentMode('speakerTrack');
      return;
    }
  } catch (e) {
    console.log('Could not read SpeakerTrack status:', e.message);
  }

  if (availableModes.some(m => m.key === 'presenterTrack')) {
    try {
      const ptStatus = await xapi.Status.Cameras.PresenterTrack.Status.get();
      if (ptStatus === 'Follow') {
        setCurrentMode('presenterTrack');
        return;
      }
    } catch (e) {
      console.log('Could not read PresenterTrack status:', e.message);
    }
  }

  setCurrentMode('manual');
}

async function setCurrentMode(modeKey) {
  currentMode = modeKey;
  const mode = availableModes.find(m => m.key === modeKey);

  console.log('Current camera mode:', mode?.name ?? modeKey);
  await buildAllPanels();
}

async function changeSource(connectorId) {
  if (typeof connectorId == 'undefined') return
  if (isNaN(connectorId)) return

  const currentSource = await xapi.Status.Video.Input.MainVideoSource.get()

  if (connectorId == currentSource) {
    console.log('Current Source:', currentSource, '- Required Source:', connectorId, '- No change required');
    return
  }


  console.log('Current Source:', currentSource, '- Required Source:', connectorId, '- Setting Main Video To:', connectorId);
  // ConnectorId is documented as an array (it is the same parameter
  // shape used for compositing two sources). The bare-number form is
  // tolerated by some firmware but reported broken on newer RoomOS
  // builds, so use the documented array form even for a single input.
  xapi.Command.Video.Input.SetMainVideoSource({ ConnectorId: [connectorId] });
  const associatedCameraId = await getDetectedCameraId(connectorId);

  if (activeCameraId == associatedCameraId) return

  activeCameraId = associatedCameraId;


  setCameraSelectWidgetValue(associatedCameraId);

}

function setCameraSelectWidgetValue(value) {
  if (ptzCameras.length < 2) return;
  if (isNaN(value)) return;
  console.log('Setting Camera Selection Widget Value To:', value);

  // Mirror buildAllPanels() surface logic: on MTR we publish only to
  // the ControlPanel twin, so target only the CP-suffixed widget id.
  // On RoomOS, write to the HSCC widget always and to the CP twin if
  // dual-publish is configured.
  const targets = [];
  if (!isMTR) targets.push(CAM_SELECT_ID);
  if (isMTR || config.publishToControlPanel) targets.push(CAM_SELECT_ID_CP);

  for (const widgetId of targets) {
    xapi.Command.UserInterface.Extensions.Widget.SetValue({
      WidgetId: widgetId,
      Value: String(value)
    }).catch(e => {
      // Twin widget may not exist yet during initial save sequence -- safe to ignore.
      console.log('  camera selector setValue skipped for', widgetId + ':', e.message);
    });
  }
}



async function applyMode(modeKey) {
  console.log('Applying camera mode:', modeKey);
  applyingMode = true;



  let requiredSource

  try {
    switch (modeKey) {
      case 'speakerTrack':
        requiredSource = await xapi.Status.Cameras.SpeakerTrack.ActiveConnector.get()
          .catch(() => { return 1 });
        await xapi.Command.Cameras.SpeakerTrack.Activate();
        dismissSelfview();
        break;
      case 'presenterTrack':
        requiredSource = await xapi.Config.Cameras.PresenterTrack.Connector.get()
        await xapi.Command.Cameras.PresenterTrack.Set({ Mode: 'Follow' });
        dismissSelfview();
        break;
      case 'manual':
        await xapi.Command.Cameras.SpeakerTrack.Deactivate();
        break;
      default:
        console.warn('Unknown camera mode:', modeKey);
        applyingMode = false;
        return;
    }
    await setCurrentMode(modeKey);
  } catch (e) {
    console.error('Error applying camera mode:', modeKey, e.message);
  }

  await changeSource(requiredSource)



  unrefTimer(setTimeout(() => { applyingMode = false; }, 2000));
}

function applyDefaultWithDebounce() {
  const now = Date.now();
  if (now - lastCallApplyTime < 3000) return;
  lastCallApplyTime = now;
  applyMode(config.defaultMode);
}

/*********************************************************
 * SELFVIEW (RoomOS only)
 *
 * Briefly shows the self-view picture-in-picture when
 * the user interacts with PTZ controls, then auto-hides
 * it after a timeout. Skipped entirely on MTRoA where
 * the Teams UI provides its own always-on self-view.
 *********************************************************/

function flashSelfview() {
  if (isMTR) return;

  xapi.Command.Video.Selfview.Set({ Mode: 'On', FullscreenMode: 'Off' })
    .catch(e => console.log('Could not enable selfview:', e.message));

  if (selfviewTimer) clearTimeout(selfviewTimer);
  selfviewTimer = unrefTimer(setTimeout(() => {
    xapi.Command.Video.Selfview.Set({ Mode: 'Off' })
      .catch(e => console.log('Could not disable selfview:', e.message));
    selfviewTimer = null;
  }, config.selfviewTimeout));
}

function dismissSelfview() {
  if (isMTR) return;

  if (selfviewTimer) {
    clearTimeout(selfviewTimer);
    selfviewTimer = null;
    xapi.Command.Video.Selfview.Set({ Mode: 'Off' })
      .catch(e => console.log('Could not disable selfview:', e.message));
  }
}

/*********************************************************
 * EVENT LISTENERS
 *
 * Registers listeners for device status changes and
 * call events. All registrations are wrapped in
 * try/catch so a missing xAPI path on one platform
 * doesn't prevent the macro from starting.
 *********************************************************/

function registerStatusListeners(ptAvailable) {
  try {
    xapi.Status.Cameras.SpeakerTrack.Status.on(handleSpeakerTrackChange);
    console.log('Listener registered: SpeakerTrack.Status');
  } catch (e) {
    console.warn('Could not register SpeakerTrack.Status listener:', e.message);
  }

  if (ptAvailable) {
    try {
      xapi.Status.Cameras.PresenterTrack.Status.on(handlePresenterTrackChange);
      console.log('Listener registered: PresenterTrack.Status');
    } catch (e) {
      console.warn('Could not register PresenterTrack.Status listener:', e.message);
    }
  }
}

function registerCallListeners() {
  if (!config.newCallApplyDefault) return;

  try {
    xapi.Status.Call.on(({ Status, id }) => {
      if (Status && Status === 'Connected' && callId !== id) {
        callId = id;
        applyDefaultWithDebounce();
      }
    });
    console.log('Listener registered: Call.Status');
  } catch (e) {
    console.warn('Could not register Call.Status listener:', e.message);
  }

  try {
    xapi.Status.MicrosoftTeams.Calling.InCall.on((inCall) => {
      if (inCall === 'True') {
        applyDefaultWithDebounce();
      }
    });
    console.log('Listener registered: MicrosoftTeams.Calling.InCall');
  } catch (e) {
    console.log('Teams call listener not available:', e.message);
  }
}

/*********************************************************
 * EVENT HANDLERS
 *
 * Respond to user interactions with the Control Panel
 * buttons and PTZ widgets, and to device-initiated
 * camera tracking changes.
 *
 * normalizeId() collapses a CP-suffixed id (Control Panel
 * twin) back to its base form so all handlers can match
 * against a single canonical id regardless of which
 * surface fired the event.
 *********************************************************/

function normalizeId(id) {
  return (typeof id === 'string' && id.endsWith(CP_SUFFIX))
    ? id.slice(0, -CP_SUFFIX.length)
    : id;
}

function handlePanelClicked(event) {
  const panelId = normalizeId(event.PanelId);
  const modeMatch = availableModes.find(m => m.panelId === panelId);
  if (modeMatch) {
    console.log('Mode button clicked:', modeMatch.name, '(via', event.PanelId + ')');
    applyMode(modeMatch.key);
    return;
  }

  if (panelId === REPLICA_VIDEO_MUTE_ID) {
    handleReplicaVideoMuteClick().catch(e => console.error('Replica video mute click failed:', e.message));
    return;
  }
  if (panelId === REPLICA_HAND_ID) {
    handleReplicaHandClick().catch(e => console.error('Replica hand click failed:', e.message));
    return;
  }
  if (panelId === REPLICA_RECORD_ID) {
    handleReplicaRecordClick().catch(e => console.error('Replica record click failed:', e.message));
    return;
  }
}

function handlePageAction(event) {
  if (normalizeId(event.PageId) === MANUAL_PAGE_ID && event.Type === 'Opened') {
    console.log('Manual PTZ page opened (via', event.PageId + ')');
    if (currentMode !== 'manual') {
      applyMode('manual');
    }
  }
}

function processWidgetAction(event) {
  const { WidgetId, Type, Value } = event;
  const widgetId = normalizeId(WidgetId);

  if (widgetId === CAM_SELECT_ID && Type === 'pressed') {
    // Defensive: widget Value is a string; parseInt returns NaN for
    // anything non-numeric. Bail rather than poke the camera state with
    // a NaN id.
    const selectedCameraId = parseInt(Value);
    if (isNaN(selectedCameraId)) return;

    activeCameraId = selectedCameraId;
    console.log('Active PTZ camera changed:', activeCameraId, '(via', WidgetId + ')');

    // The widget value is a Camera id (1..N), but changeSource() takes
    // a connector id. On devices where they match (the common single-
    // camera case) the fallback `?? selectedCameraId` preserves the
    // pre-existing behavior; on devices where they diverge (multi-cam
    // Codec Pro etc.) we route to the right physical input by using
    // the connectorId we recorded in detectPTZCameras().
    const selectedCamera = ptzCameras.find(c => c.id === selectedCameraId);
    changeSource(selectedCamera?.connectorId ?? selectedCameraId);
    return;
  }

  if (widgetId === PTZ_PAD_ID) {
    handlePTZPad(Type, Value);
    return;
  }

  if (widgetId === ZOOM_IN_ID || widgetId === ZOOM_OUT_ID) {
    handleZoom(widgetId, Type);
    return;
  }
}

function handlePTZPad(type, direction) {
  const cam = { CameraId: activeCameraId };

  if (type === 'pressed') {
    flashSelfview();
    switch (direction) {
      case 'up':
        xapi.Command.Camera.Ramp({ ...cam, Tilt: 'Up' })
          .catch(e => console.error('PTZ error:', e.message));
        break;
      case 'down':
        xapi.Command.Camera.Ramp({ ...cam, Tilt: 'Down' })
          .catch(e => console.error('PTZ error:', e.message));
        break;
      case 'left':
        xapi.Command.Camera.Ramp({ ...cam, Pan: 'Left' })
          .catch(e => console.error('PTZ error:', e.message));
        break;
      case 'right':
        xapi.Command.Camera.Ramp({ ...cam, Pan: 'Right' })
          .catch(e => console.error('PTZ error:', e.message));
        break;
      case 'center':
        xapi.Command.Camera.TriggerAutofocus({ CameraId: activeCameraId })
          .catch(e => console.log('Autofocus not supported:', e.message));
        return;
    }
  } else if (type === 'released') {
    xapi.Command.Camera.Ramp({ ...cam, Pan: 'Stop', Tilt: 'Stop' })
      .catch(e => console.error('PTZ stop error:', e.message));
  }
}

function handleZoom(widgetId, type) {
  const cam = { CameraId: activeCameraId };

  if (type === 'pressed') {
    flashSelfview();
    const direction = widgetId === ZOOM_IN_ID ? 'In' : 'Out';
    xapi.Command.Camera.Ramp({ ...cam, Zoom: direction })
      .catch(e => console.error('Zoom error:', e.message));
  } else if (type === 'released') {
    xapi.Command.Camera.Ramp({ ...cam, Zoom: 'Stop' })
      .catch(e => console.error('Zoom stop error:', e.message));
  }
}

function handleSpeakerTrackChange(status) {
  if (applyingMode) return;

  console.log('Device SpeakerTrack status changed:', status);

  if (status === 'Active' && currentMode !== 'speakerTrack') {
    setCurrentMode('speakerTrack');
  } else if (status === 'Inactive' && currentMode === 'speakerTrack') {
    syncState();
  }
}

function handlePresenterTrackChange(status) {
  if (applyingMode) return;

  console.log('Device PresenterTrack status changed:', status);

  if (status === 'Follow' && currentMode !== 'presenterTrack') {
    setCurrentMode('presenterTrack');
  } else if (status === 'Off' && currentMode === 'presenterTrack') {
    syncState();
  }
}

/*********************************************************
 * ICON RESOLUTION (v2)
 *
 * Two icon kinds are supported throughout the macro:
 *
 *   built-in  -- a stock RoomOS icon name. Renders as
 *                <Icon>Camera</Icon> in the panel XML.
 *   custom    -- a 'custom:<key>' string that resolves to
 *                CUSTOM_ICONS[<key>], populated by the
 *                tools/embed-icons.js workflow. Renders as
 *                <Icon>Custom</Icon> + a separate
 *                <CustomIcon>...</CustomIcon> block placed
 *                AFTER <ActivityType> in the panel XML to
 *                match Cisco's exported element order.
 *
 * The two-helper split (buildIconElement / buildCustomIconBlock)
 * exists because Cisco's UI Editor exports panel XML with
 * <CustomIcon> after <ActivityType>, not adjacent to <Icon>;
 * matching that layout reliably renders custom icons. The
 * <Id> field inside <CustomIcon> is the SHA-256 of the
 * base64 string of the PNG, computed by tools/embed-icons.js.
 *
 * Custom icons may have an optional 'active' variant; when
 * the calling code passes isActive=true and the variant
 * exists, the active variant is rendered instead of the
 * default. Camera mode buttons always pass isActive=false
 * (they signal active mode via a label checkmark prefix).
 *********************************************************/

function resolveIcon(spec) {
  if (typeof spec === 'string' && spec.startsWith('custom:')) {
    const key = spec.slice('custom:'.length);
    const variants = CUSTOM_ICONS?.[key];
    if (!variants) {
      console.warn('Icon spec "' + spec + '" has no matching CUSTOM_ICONS entry; falling back to built-in Camera');
      return { type: 'builtin', name: 'Camera' };
    }
    return { type: 'custom', key, variants };
  }
  return { type: 'builtin', name: (typeof spec === 'string' && spec) ? spec : 'Camera' };
}

// Cisco's exported panel XML places <CustomIcon> AFTER <ActivityType>, not
// adjacent to <Icon>. Splitting the icon markup into two helpers lets each
// panel template emit them at the correct positions:
//
//   <Icon>...</Icon>          <- buildIconElement(resolved)
//   <Name>...</Name>
//   <ActivityType>...</ActivityType>
//   <CustomIcon>...</CustomIcon>   <- buildCustomIconBlock(resolved, isActive)
//
// Built-in icons return an empty CustomIcon block (just '').
function buildIconElement(resolved) {
  if (resolved.type === 'builtin') {
    return '<Icon>' + resolved.name + '</Icon>';
  }
  return '<Icon>Custom</Icon>';
}

function buildCustomIconBlock(resolved, isActive) {
  if (resolved.type !== 'custom') return '';
  const variant = (isActive && resolved.variants.active)
    ? resolved.variants.active
    : resolved.variants.default;
  if (!variant) {
    console.warn('Icon "' + resolved.key + '" has no usable variant; omitting CustomIcon block');
    return '';
  }
  return '<CustomIcon>\n          <Content>' + variant.content +
         '</Content>\n          <Id>' + variant.id + '</Id>\n        </CustomIcon>';
}

/*********************************************************
 * UI CONSTRUCTION
 *
 * Builds and saves the camera-mode panels as XML via the
 * xAPI. Each mode is published to one or more surfaces
 * defined in PANEL_LOCATIONS (HomeScreenAndCallControls
 * always; ControlPanel additionally if config flag is set).
 *
 * Speaker Track and Presenter Track are pageless action
 * buttons; Manual includes a Page with PTZ controls. The
 * Control Panel twin's PTZ page uses CP-suffixed widget
 * ids so that RoomOS's device-wide widget id uniqueness
 * rule is respected.
 *********************************************************/

async function buildAllPanels() {
  // Surface selection rules:
  //
  //   RoomOS: HomeScreenAndCallControls always (home screen + in-call
  //           bar), and ControlPanel side flyout if the operator has
  //           opted in via config.publishToControlPanel (default true).
  //
  //   MTR:    ControlPanel side flyout ONLY -- HSCC publication is
  //           skipped entirely. The Teams shell on MTR varies its
  //           handling of HSCC panels by call type and firmware, so
  //           an HSCC button might appear in a Webex CVI call but be
  //           suppressed in a native Teams meeting (or vice-versa)
  //           depending on the room's configuration. That inconsistency
  //           creates a disjointed user experience for organizations
  //           with mixed RoomOS/MTR fleets ("why is the button missing
  //           in this room?"). Publishing exclusively to the side
  //           flyout on MTR gives users one universally-reliable place
  //           to find camera mode buttons regardless of meeting
  //           platform, and makes user-facing instructions simple.
  //           config.publishToControlPanel is force-overridden to true
  //           on MTR because there's no alternative surface to fall
  //           back to.
  const wantHSCC = !isMTR;
  const wantCP = isMTR || config.publishToControlPanel;

  if (isMTR && !config.publishToControlPanel) {
    console.warn('MTR mode: forcing ControlPanel publication on (config.publishToControlPanel was false, but MTR has no other reliable surface for camera mode buttons)');
  }

  for (const mode of availableModes) {
    if (wantHSCC) await saveModeButton(mode, PANEL_LOCATIONS.HSCC);
    if (wantCP)   await saveModeButton(mode, PANEL_LOCATIONS.CP);
  }
}

async function saveModeButton(mode, locDef) {
  const isActive = (mode.key === currentMode);
  const label = isActive ? ('\u2713 ' + mode.name) : mode.name;
  const iconResolved = resolveIcon(config.icons[mode.key]);
  const iconElement = buildIconElement(iconResolved);
  const customIconBlock = buildCustomIconBlock(iconResolved, false);
  const order = PANEL_ORDER[mode.key] ?? 99;
  const panelId = mode.panelId + locDef.panelSuffix;

  let xml;

  if (mode.key === 'manual' && activeCameraId !== null) {
    xml = buildManualPanelXml(label, iconElement, customIconBlock, order, locDef);
  } else {
    xml = `
    <Extensions>
      <Panel>
        <Order>${order}</Order>
        <Location>${locDef.location}</Location>
        ${iconElement}
        <Name>${label}</Name>
        <ActivityType>Custom</ActivityType>
        ${customIconBlock}
      </Panel>
    </Extensions>`;
  }

  try {
    if (config.debugXml) dumpPanelXml('saveModeButton', panelId, xml);
    await xapi.Command.UserInterface.Extensions.Panel.Save(
      { PanelId: panelId },
      xml
    );

    if (mode.key === 'manual' && ptzCameras.length > 1 && activeCameraId !== null) {
      setCameraSelectWidgetValue(activeCameraId);
    }
  } catch (e) {
    console.error('Failed to save mode button', panelId, '-', e.message);
  }
}

function buildManualPanelXml(label, iconElement, customIconBlock, order, locDef) {
  const w = locDef.widgets;
  let camSelectorRow = '';
  if (ptzCameras.length > 1) {

    const camValues = ptzCameras.map(({ id, name }) => `<Value><Key>${id}</Key><Name>${name}</Name></Value>`).join('');

    camSelectorRow = `
          <Row>
            <Name>Camera</Name>
            <Widget>
              <WidgetId>${w.camSelect}</WidgetId>
              <Type>GroupButton</Type>
              <Options>size=4</Options>
              <ValueSpace>${camValues}
              </ValueSpace>
            </Widget>
          </Row>`;
  }

  return `
    <Extensions>
      <Panel>
        <Order>${order}</Order>
        <Location>${locDef.location}</Location>
        ${iconElement}
        <Name>${label}</Name>
        <ActivityType>Custom</ActivityType>
        ${customIconBlock}
        <Page>
          <PageId>${locDef.pageId}</PageId>
          <Name>Camera Controls</Name>${camSelectorRow}
          <Row>
            <Name>PTZ</Name>
            <Widget>
              <WidgetId>camPTZLabelBtn${locDef.panelSuffix}</WidgetId>
              <Name>Pan / Tilt</Name>
              <Type>Text</Type>
              <Options>size=1;fontSize=small;align=center</Options>
            </Widget>
            <Widget>
              <WidgetId>${w.ptzPad}</WidgetId>
              <Type>DirectionalPad</Type>
              <Options>size=1</Options>
            </Widget>
            <Widget>
              <WidgetId>${w.zoomIn}</WidgetId>
              <Type>Button</Type>
              <Options>size=1;icon=plus</Options>
            </Widget>
            <Widget>
              <WidgetId>${w.zoomOut}</WidgetId>
              <Type>Button</Type>
              <Options>size=1;icon=minus</Options>
            </Widget>
          </Row>
          <Options>hideRowNames=1</Options>
        </Page>
      </Panel>
    </Extensions>`;
}

/*********************************************************
 * DIAGNOSTICS
 *
 * Optional one-time log dump after init that captures
 * the device environment for troubleshooting. Controlled
 * by config.diagnostics.
 *********************************************************/

async function runDiagnostics() {
  console.log('--- Diagnostics ---');
  console.log('[diag] Device mode:', isMTR ? 'MTRoA' : 'RoomOS');

  try {
    const st = await xapi.Status.Cameras.SpeakerTrack.Status.get();
    console.log('[diag] SpeakerTrack.Status:', st);
  } catch (e) {
    console.warn('[diag] SpeakerTrack.Status: UNAVAILABLE -', e.message);
  }

  try {
    const ptEnabled = await xapi.Config.Cameras.PresenterTrack.Enabled.get();
    console.log('[diag] PresenterTrack.Enabled:', ptEnabled);
  } catch (e) {
    console.warn('[diag] PresenterTrack.Enabled: UNAVAILABLE -', e.message);
  }

  if (availableModes.some(m => m.key === 'presenterTrack')) {
    try {
      const ptStatus = await xapi.Status.Cameras.PresenterTrack.Status.get();
      console.log('[diag] PresenterTrack.Status:', ptStatus);
    } catch (e) {
      console.warn('[diag] PresenterTrack.Status: UNAVAILABLE -', e.message);
    }
  }

  console.log('[diag] PTZ cameras:', ptzCameras.length > 0
    ? ptzCameras.map(c => c.id + ' (' + c.name + ')').join(', ')
    : 'none');
  console.log('[diag] Active PTZ camera:', activeCameraId ?? 'none');

  try {
    const sv = await xapi.Status.Video.Selfview.Mode.get();
    console.log('[diag] Selfview.Mode:', sv);
  } catch (e) {
    console.warn('[diag] Selfview.Mode: UNAVAILABLE -', e.message);
  }

  if (isMTR) {
    try {
      const inCall = await xapi.Status.MicrosoftTeams.Calling.InCall.get();
      console.log('[diag] MicrosoftTeams.Calling.InCall:', inCall);
    } catch (e) {
      console.warn('[diag] MicrosoftTeams.Calling.InCall: UNAVAILABLE -', e.message);
    }
  }

  console.log('[diag] Current mode:', currentMode);
  console.log('--- End Diagnostics ---');
}

/*********************************************************
 * LIFECYCLE LOGGING HELPERS (v2)
 *
 * All v2 native-control + replica panel lifecycle logs use
 * the `[lc]` prefix so they can be grepped out of macro
 * console dumps without pulling unrelated chatter.
 *********************************************************/

function lcLog(...args)  { console.log('[lc]', ...args); }
function lcWarn(...args) { console.warn('[lc]', ...args); }
function lcError(...args){ console.error('[lc]', ...args); }

/*********************************************************
 * NATIVE CONTROL LIFECYCLE (v2)
 *
 * Manages xConfiguration UserInterface Features Call.<Name>
 * settings so that each native mid-call control is hidden
 * only while a call is active AND its custom replica is
 * about to be saved. When the call ends, every config we
 * touched is restored to the value captured at macro start.
 *
 * NATIVE_CONFIG_REPLICAS maps each managed config to the
 * replica keys it gates:
 *   VideoMute        -> [videoMute]
 *   MidCallControls  -> [hand, record]   (hides Hand, Record,
 *                                         More, Hold, Transfer,
 *                                         Resume per RoomOS docs)
 *
 * A config is hidden only if at least one of its mapped
 * replicas has both .enabled = true in config.customReplicas
 * AND a true entry in the per-call support map produced by
 * probeCallContext().
 *
 * Captured baselines persist across calls within a macro
 * session, so the macro restores to whatever the device
 * had at startup, not a hardcoded 'Auto'.
 *
 * The per-call work is driven by reconcileNativeForCall(),
 * which is idempotent and safe to run repeatedly. It compares
 * the desired state (derived from supportMap + replica
 * enabled flags) against the tracked state (hidesAppliedNames)
 * and makes the minimum set of xConfiguration writes needed
 * to converge. This is what makes back-to-back call
 * transitions with different capability sets safe, including
 * the case where a previous call's ghost event never fires.
 *********************************************************/

const NATIVE_CONFIG_REPLICAS = {
  VideoMute: ['videoMute'],
  MidCallControls: ['hand', 'record']
};

async function captureNativeControlsBaseline() {
  // Defense-in-depth: init() already gates the call site, but if any
  // future caller invokes this on an MTR device we still want a no-op.
  // The xConfiguration UserInterface.Features.Call.* paths are not
  // honored on MTR the same way they are on RoomOS, so reading and
  // sanitizing them is meaningless on that platform.
  if (isMTR) {
    lcLog('Skipping native control baseline capture: MTR mode');
    return;
  }
  lcLog('Capturing native control baseline (' + Object.keys(NATIVE_CONFIG_REPLICAS).length + ' configs)');
  for (const name of Object.keys(NATIVE_CONFIG_REPLICAS)) {
    try {
      originalNativeConfigs[name] = await xapi.Config.UserInterface.Features.Call[name].get();
      lcLog('  baseline UserInterface.Features.Call.' + name + ' =', originalNativeConfigs[name]);
    } catch (e) {
      originalNativeConfigs[name] = null;
      lcWarn('  baseline UserInterface.Features.Call.' + name + ' UNAVAILABLE:', e.message);
    }
  }

  if (config.trustNativeHiddenAtStartup) {
    lcLog('Baseline sanitization skipped (config.trustNativeHiddenAtStartup = true)');
    return;
  }

  // Detect the most dangerous leftover: the macro was reloaded / crashed
  // between "hide phase" (start of a call) and "restore phase" (end of a
  // call). In that state the on-device config shows Hidden, but 'Auto' is
  // the user's real intent. Without this sanitization step the macro would
  // capture Hidden as the baseline and "restore" to Hidden at the next
  // call's teardown, leaving native controls permanently invisible.
  let systemState = 'Unknown';
  try { systemState = await xapi.Status.SystemUnit.State.System.get(); } catch (e) { /* ignore */ }
  const inCall = (systemState === 'InCall');

  for (const name of Object.keys(originalNativeConfigs)) {
    if (originalNativeConfigs[name] !== 'Hidden') continue;

    if (inCall) {
      // Mid-call reload after our hide phase already ran. Leave the
      // on-device value as Hidden (our custom replicas are about to be
      // re-rendered by recoverActiveCallIfAny) but rewrite the baseline to
      // Auto AND claim ownership of the hide so teardownReplicas restores
      // correctly at call-end.
      lcWarn('[recovery] stale Hidden baseline for ' + name + ' while in call -- adopting ownership (baseline := Auto)');
      originalNativeConfigs[name] = 'Auto';
      hidesAppliedNames.add(name);
    } else {
      // No call active. Overwhelmingly likely to be our leftover -- restore
      // to Auto immediately so the device UI returns to normal, and record
      // Auto as the baseline going forward.
      lcWarn('[recovery] stale Hidden value for ' + name + ' with no active call -- restoring to Auto now');
      try {
        await xapi.Config.UserInterface.Features.Call[name].set('Auto');
        originalNativeConfigs[name] = 'Auto';
        lcLog('[recovery]   RESTORED ' + name + ' = Auto');
      } catch (e) {
        lcWarn('[recovery]   FAILED to restore ' + name + ':', e.message);
      }
    }
  }
}

/*********************************************************
 * If the macro starts while a call is already in progress
 * (edit-and-reload cycle during development, or a runtime
 * crash-recovery), we need to re-bind the replica lifecycle
 * to the existing call rather than wait for the next Status
 * .Call Connected event (which will never arrive for a call
 * that's been Connected for minutes).
 *
 * Called from init() after all listeners are registered so
 * any Status.Call ghost event that fires during the recovery
 * sync (e.g. user hangs up mid-recovery) is handled by the
 * already-wired teardown path.
 *********************************************************/
async function recoverActiveCallIfAny() {
  // Defense-in-depth: same rationale as captureNativeControlsBaseline.
  // The replica pipeline is RoomOS-only; an MTR macro reload mid-call
  // has nothing to recover because the macro never set up the in-call
  // state in the first place.
  if (isMTR) {
    lcLog('Skipping active-call recovery: MTR mode');
    return;
  }
  let systemState = 'Unknown';
  try { systemState = await xapi.Status.SystemUnit.State.System.get(); } catch (e) { /* ignore */ }
  if (systemState !== 'InCall') return;

  let calls = [];
  try { calls = await xapi.Status.Call.get(); } catch (e) { /* ignore */ }
  const active = (calls || []).find(c => c.Status === 'Connected');

  if (!active) {
    lcLog('[recovery] SystemUnit.State.System = InCall but no Connected entry in Status.Call; nothing to recover');
    return;
  }

  lcLog('[recovery] =================================================');
  lcLog('[recovery] Macro started while call ' + active.id + ' is already in progress');
  lcLog('[recovery] Rebinding replica lifecycle and re-rendering panels');
  lcLog('[recovery] =================================================');

  activeReplicaCallId = active.id;
  try {
    await syncReplicaPanels(active.id);
    lcLog('[recovery] replica recovery for call ' + active.id + ' complete');
  } catch (e) {
    lcError('[recovery] replica recovery failed:', e.message);
  }
}

/**
 * Reconcile the device's native mid-call control visibility to exactly
 * match what the current call needs. Replaces the older one-way
 * "hideNativeForCall" helper.
 *
 * For each managed xConfiguration (see NATIVE_CONFIG_REPLICAS) this
 * computes whether it SHOULD be hidden right now -- defined as "at
 * least one replica mapped to this config is both config.customReplicas
 * .*.enabled AND reported as supported by the current call's
 * capability probe" -- and then drives the on-device value to match:
 *
 *   | desired  | currently tracked | action
 *   |----------|-------------------|-----------------------------------
 *   | hide     | not hidden        | set('Hidden'), track ownership
 *   | hide     | hidden            | no-op (already correct)
 *   | show     | hidden            | set(baseline), release ownership
 *   | show     | not hidden        | no-op (already correct)
 *
 * Why a reconcile loop instead of a one-way "hide" loop?
 *
 *   1. Back-to-back calls with different capabilities (merge, attended
 *      transfer, same-meeting re-connect, or any sequence where the
 *      previous call's ghost event never fires or arrives after the
 *      next call's Connected event). A one-way hide would see entries
 *      left in hidesAppliedNames from Call A, skip them on Call B, and
 *      leave Call B's in-call bar with a hidden native AND no replica
 *      (because applyReplicaPanel later removes the replica for a
 *      capability Call B doesn't have).
 *
 *   2. Mid-call capability changes (host revokes recording permission,
 *      breakout rooms narrow the participant view, etc). Today the
 *      macro only re-syncs on Connected/ghost, but if/when we add a
 *      Status.Conference.Call.Capabilities listener it will "just work"
 *      -- reconciling is idempotent and safe to call repeatedly.
 *
 *   3. Runtime edits to config.customReplicas.*.enabled. Toggling a
 *      replica off should bring the corresponding native back without
 *      requiring the user to bounce the call. Reconcile handles this
 *      for free the next time sync runs.
 *
 * Ordering note (intentional): this function runs BEFORE
 * applyReplicaPanel in syncReplicaPanels. When we RELEASE a hide
 * (native becomes visible again), the corresponding replica is removed
 * a moment later. This briefly shows native + replica together rather
 * than briefly showing nothing -- the less-confusing of the two
 * possible flicker orderings.
 */
async function reconcileNativeForCall(supportMap) {
  lcLog('Reconcile phase: evaluating native controls vs support', JSON.stringify(supportMap));
  let hidCount = 0;
  let releasedCount = 0;
  let keptCount = 0;

  for (const [configName, replicaKeys] of Object.entries(NATIVE_CONFIG_REPLICAS)) {
    // Skip anything the device didn't expose at baseline capture time
    // (e.g. older RoomOS or a hardware SKU that doesn't advertise this
    // config path). We can't hide what we can't read, and we certainly
    // can't restore it.
    if (originalNativeConfigs[configName] === null) {
      lcLog('  skip ' + configName + ': unsupported on this device');
      continue;
    }

    // Desired state: hide only if at least one mapped replica is both
    // enabled by operator config AND actually usable in this call.
    // The "actually usable" check is important on P2P SIP calls where
    // RaiseHand / Recording capabilities are absent -- we must NOT hide
    // MidCallControls in that case or the user loses Hold/Transfer/
    // Resume for no reason.
    const shouldHide = replicaKeys.some(replicaKey => {
      if (!supportMap[replicaKey]) return false;
      const cfgKey = (replicaKey === 'hand') ? 'raiseHand' : replicaKey;
      return config.customReplicas?.[cfgKey]?.enabled !== false;
    });

    const isHidden = hidesAppliedNames.has(configName);

    if (shouldHide && !isHidden) {
      // Transition: visible -> hidden. Claim ownership so teardown /
      // future reconciles know this hide is ours to release.
      try {
        await xapi.Config.UserInterface.Features.Call[configName].set('Hidden');
        hidesAppliedNames.add(configName);
        hidCount++;
        lcLog('  HID ' + configName + ' (replicas: ' + replicaKeys.join(',') + ')');
      } catch (e) {
        lcWarn('  FAILED to hide ' + configName + ':', e.message);
      }
    } else if (!shouldHide && isHidden) {
      // Transition: hidden -> visible. This branch is what fixes the
      // back-to-back call regression: it restores a native that the
      // previous call needed hidden but the current call does not.
      // We restore to the captured baseline rather than hardcoding
      // 'Auto' so admin-customized defaults survive.
      const baseline = originalNativeConfigs[configName] ?? 'Auto';
      try {
        await xapi.Config.UserInterface.Features.Call[configName].set(baseline);
        hidesAppliedNames.delete(configName);
        releasedCount++;
        lcLog('  RELEASED ' + configName + ' = ' + baseline +
              ' (no longer needed for this call; replicas: ' + replicaKeys.join(',') + ')');
      } catch (e) {
        lcWarn('  FAILED to release ' + configName + ':', e.message);
      }
    } else {
      // Steady state: on-device value already matches desired. The
      // common path on subsequent reconciles within the same call.
      keptCount++;
      lcLog('  keep ' + configName + ' ' + (isHidden ? '(hidden)' : '(visible)') + ' -- already matches desired');
    }
  }

  lcLog('Reconcile phase complete: ' + hidCount + ' hid, ' +
        releasedCount + ' released, ' + keptCount + ' unchanged; tracked set =',
        JSON.stringify([...hidesAppliedNames]));
}

async function restoreNativeFromCall() {
  if (hidesAppliedNames.size === 0) {
    lcLog('Restore phase: nothing to restore (no hides were applied this call)');
    return;
  }
  lcLog('Restore phase: restoring ' + hidesAppliedNames.size + ' native control(s) from baseline');
  let restored = 0;
  for (const configName of [...hidesAppliedNames]) {
    const original = originalNativeConfigs[configName];
    hidesAppliedNames.delete(configName);
    if (original === null || original === undefined) {
      lcWarn('  skip ' + configName + ': no baseline value captured');
      continue;
    }
    try {
      await xapi.Config.UserInterface.Features.Call[configName].set(original);
      restored++;
      lcLog('  RESTORED ' + configName + ' =', original);
    } catch (e) {
      lcWarn('  FAILED to restore ' + configName + ':', e.message);
    }
  }
  lcLog('Restore phase complete: ' + restored + ' control(s) restored');
}

/*********************************************************
 * CUSTOM REPLICA PANELS (v2)
 *
 * Adds CallControls-located action buttons that replicate
 * the hidden native controls (Video Mute, Raise Hand, Record).
 * Each replica is added on call connect ONLY if the active
 * call context exposes that capability, and removed on call
 * end. Live state from the device is mirrored back into the
 * button label (e.g. checkmark prefix when recording is
 * active, "Mute" <-> "Unmute" toggle).
 *
 * Detection oracles (locked in by Phase 2 device probe):
 *   videoMute -> Status.SystemUnit.State.System === 'InCall'
 *   hand      -> Status.Conference.Call[*].Capabilities.RaiseHand
 *                === 'Available'
 *   record    -> Status.Conference.Call[*].Capabilities
 *                .Recording.Start === 'Available'
 *********************************************************/

const REPLICA_DEFS = {
  videoMute: {
    key: 'videoMute',
    panelId: REPLICA_VIDEO_MUTE_ID,
    order: PANEL_ORDER.replicaVideoMute,
    baseName: 'Video Mute',
    activeName: 'Unmute Video',
    inactiveName: 'Mute Video'
  },
  hand: {
    key: 'hand',
    panelId: REPLICA_HAND_ID,
    order: PANEL_ORDER.replicaHand,
    baseName: 'Raise Hand',
    activeName: '\u2713 Lower Hand',
    inactiveName: 'Raise Hand'
  },
  record: {
    key: 'record',
    panelId: REPLICA_RECORD_ID,
    order: PANEL_ORDER.replicaRecord,
    baseName: 'Record',
    activeName: '\u2713 Stop Recording',
    inactiveName: 'Record'
  }
};

function registerReplicaListeners() {
  // Call lifecycle: bind / tear down replicas on connect / disconnect.
  try {
    xapi.Status.Call.on(handleReplicaCallEvent);
    lcLog('Listener registered: Status.Call (replicas)');
  } catch (e) {
    lcWarn('Could not register replica call listener:', e.message);
  }

  // Live state sync: re-render replica labels when the underlying
  // feature state changes mid-call.
  try {
    xapi.Status.Video.Input.MainVideoMute.on(value => {
      lcLog('Status.Video.Input.MainVideoMute changed ->', value);
      syncReplicaLabel('videoMute');
    });
    lcLog('Listener registered: Status.Video.Input.MainVideoMute');
  } catch (e) {
    lcWarn('Could not register MainVideoMute listener:', e.message);
  }
  try {
    xapi.Status.Conference.Call.RaiseHand.on(value => {
      lcLog('Status.Conference.Call.RaiseHand changed ->', JSON.stringify(value));
      syncReplicaLabel('hand');
    });
    lcLog('Listener registered: Status.Conference.Call.RaiseHand');
  } catch (e) {
    lcWarn('Could not register Conference.Call.RaiseHand listener:', e.message);
  }
  try {
    xapi.Status.Conference.Call.Recording.on(value => {
      lcLog('Status.Conference.Call.Recording changed ->', JSON.stringify(value));
      syncReplicaLabel('record');
    });
    lcLog('Listener registered: Status.Conference.Call.Recording');
  } catch (e) {
    lcWarn('Could not register Conference.Call.Recording listener:', e.message);
  }
}

function handleReplicaCallEvent(event) {
  const { Status, id, ghost } = event;
  lcLog('Status.Call event: id=' + id + ' status=' + Status + ' ghost=' + (ghost ? 'true' : 'false') + ' activeCallId=' + activeReplicaCallId);

  if (ghost) {
    if (!id) {
      lcLog('  ghost event with no id -- ignoring');
      return;
    }
    if (String(id) !== String(activeReplicaCallId)) {
      lcLog('  ghost id ' + id + ' does not match active replica call ' + activeReplicaCallId + ' -- ignoring');
      return;
    }
    lcLog('  >>> CALL ENDED (id=' + id + '), starting teardown <<<');
    teardownReplicas().catch(e => lcWarn('Replica teardown failed:', e.message));
    return;
  }

  if (Status === 'Connected' && String(id) !== String(activeReplicaCallId)) {
    lcLog('  >>> CALL CONNECTED (id=' + id + '), arming 1500ms settle timer <<<');
    activeReplicaCallId = id;
    if (replicaSettleTimer) {
      lcLog('  cleared prior settle timer');
      clearTimeout(replicaSettleTimer);
    }
    replicaSettleTimer = unrefTimer(setTimeout(() => {
      lcLog('Settle timer fired for call ' + id + ', running syncReplicaPanels');
      syncReplicaPanels(id).catch(e => lcWarn('Replica sync failed:', e.message));
    }, 1500));
    return;
  }

  if (Status) {
    lcLog('  no action (status=' + Status + ' did not trigger connect/disconnect path)');
  }
}

async function syncReplicaPanels(forCallId) {
  // Defense-in-depth: init() does not register the call lifecycle
  // listener on MTR, so this should never be reached on MTR. Guard
  // anyway in case any future code path invokes it directly --
  // probeCallContext() reads xStatus paths that aren't reliably
  // populated during Webex CVI calls on MTR, so the result would be
  // misleading and the subsequent reconcile / panel writes would be
  // misdirected.
  if (isMTR) {
    lcLog('Skipping replica panel sync for call ' + forCallId + ': MTR mode');
    return;
  }
  lcLog('--- syncReplicaPanels(call=' + forCallId + ') ---');
  const support = await probeCallContext(forCallId);
  replicaSupport = support;
  lcLog('Probe result for call ' + forCallId + ':', JSON.stringify(support));

  // Reconcile native controls FIRST so the in-call bar doesn't briefly
  // show both the natives and the custom replicas at the same time.
  //
  // reconcileNativeForCall() is idempotent: it hides what needs to be
  // hidden AND releases any leftover hides from a previous call whose
  // capabilities differ from this one (e.g. Webex meeting -> P2P SIP
  // back-to-back without a clean ghost event between them). This is
  // what keeps the macro self-healing across call transitions.
  await reconcileNativeForCall(support);

  lcLog('Save phase: applying replica panels');
  await applyReplicaPanel('videoMute', support.videoMute);
  await applyReplicaPanel('hand', support.hand);
  await applyReplicaPanel('record', support.record);
  lcLog('--- syncReplicaPanels(call=' + forCallId + ') COMPLETE ---');
}

async function applyReplicaPanel(replicaKey, supported) {
  const def = REPLICA_DEFS[replicaKey];
  const cfg = config.customReplicas?.[replicaKey === 'hand' ? 'raiseHand' : replicaKey];
  const enabled = cfg?.enabled !== false;

  if (!supported || !enabled) {
    const reason = !supported ? 'not supported by call' : 'disabled in config';
    try {
      await xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: def.panelId });
      lcLog('  replica ' + replicaKey + ' (' + def.panelId + '): REMOVED (' + reason + ')');
    } catch (e) {
      lcLog('  replica ' + replicaKey + ' (' + def.panelId + '): skipped, ' + reason + ' (no panel to remove)');
    }
    return;
  }

  const state = await computeReplicaState(replicaKey);
  const iconResolved = resolveIcon(cfg?.icon);
  const iconElement = buildIconElement(iconResolved);
  const customIconBlock = buildCustomIconBlock(iconResolved, state.active);
  const xml = buildReplicaPanelXml(def.panelId, state.label, iconElement, customIconBlock, def.order);

  try {
    if (config.debugXml) dumpPanelXml('applyReplicaPanel', def.panelId, xml);
    await xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: def.panelId }, xml);
    lcLog('  replica ' + replicaKey + ' (' + def.panelId + '): SAVED label="' + state.label +
          '" icon=' + describeIconForLog(iconResolved, state.active) + ' order=' + def.order);
  } catch (e) {
    lcError('  replica ' + replicaKey + ' (' + def.panelId + '): SAVE FAILED -', e.message);
  }
}

/*********************************************************
 * Print a panel's outgoing XML body to the console in a
 * way the Cisco macro log viewer can show fully -- splits
 * into ~250-char chunks so the log line-length cap doesn't
 * truncate base64 payloads. Gated by config.debugXml.
 *********************************************************/
function dumpPanelXml(label, panelId, xml) {
  console.log('[xml] ===== Panel.Save BEGIN  caller=' + label + '  panelId=' + panelId + '  bytes=' + xml.length + ' =====');
  const CHUNK = 240;
  for (let i = 0; i < xml.length; i += CHUNK) {
    console.log('[xml] ' + xml.slice(i, i + CHUNK));
  }
  console.log('[xml] ===== Panel.Save END    panelId=' + panelId + ' =====');
}

function buildReplicaPanelXml(panelId, label, iconElement, customIconBlock, order) {
  return `
    <Extensions>
      <Panel>
        <Order>${order}</Order>
        <Location>CallControls</Location>
        ${iconElement}
        <Name>${label}</Name>
        <ActivityType>Custom</ActivityType>
        ${customIconBlock}
      </Panel>
    </Extensions>`;
}

// Compute both the label AND the active-state flag for a replica. The flag
// is reused to drive the active-variant CustomIcon swap (e.g. red record
// indicator while recording is in progress).
async function computeReplicaState(replicaKey) {
  const def = REPLICA_DEFS[replicaKey];
  let active = false;
  try {
    if (replicaKey === 'videoMute') {
      const v = await xapi.Status.Video.Input.MainVideoMute.get();
      active = (v === 'On');
    } else if (replicaKey === 'hand') {
      // RaiseHand status values observed on RoomOS:
      //   "Inactive" -- no hand raised yet (initial)
      //   "Raised"   -- hand currently raised
      //   "Lowered"  -- hand was raised then lowered
      // Only "Raised" is the active state.
      const calls = await xapi.Status.Conference.Call.get();
      const call = (calls || []).find(c => String(c.id) === String(activeReplicaCallId)) || (calls || [])[0];
      active = (call?.RaiseHand === 'Raised');
    } else if (replicaKey === 'record') {
      const calls = await xapi.Status.Conference.Call.get();
      const call = (calls || []).find(c => String(c.id) === String(activeReplicaCallId)) || (calls || [])[0];
      active = (call?.Recording === 'Recording');
    }
  } catch (e) {
    // Path missing -- treat as inactive for label purposes.
  }
  return {
    active,
    label: active ? def.activeName : def.inactiveName
  };
}

// Convenience for clearer log lines -- shows whether the rendered icon was
// the default or active variant of a custom icon, or just a built-in name.
function describeIconForLog(resolved, isActive) {
  if (resolved.type === 'builtin') return resolved.name;
  if (isActive && resolved.variants.active) return 'custom:' + resolved.key + '/active';
  return 'custom:' + resolved.key + '/default';
}

async function syncReplicaLabel(replicaKey) {
  if (!activeReplicaCallId) {
    lcLog('Label sync skipped for ' + replicaKey + ': no active call');
    return;
  }
  if (!replicaSupport[replicaKey]) {
    lcLog('Label sync skipped for ' + replicaKey + ': not supported by current call');
    return;
  }
  const def = REPLICA_DEFS[replicaKey];
  const state = await computeReplicaState(replicaKey);
  const cfg = config.customReplicas?.[replicaKey === 'hand' ? 'raiseHand' : replicaKey];
  const iconResolved = resolveIcon(cfg?.icon);
  const iconElement = buildIconElement(iconResolved);
  const customIconBlock = buildCustomIconBlock(iconResolved, state.active);
  const xml = buildReplicaPanelXml(def.panelId, state.label, iconElement, customIconBlock, def.order);
  try {
    if (config.debugXml) dumpPanelXml('syncReplicaLabel', def.panelId, xml);
    await xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: def.panelId }, xml);
    lcLog('Label sync ' + replicaKey + ': "' + state.label +
          '" icon=' + describeIconForLog(iconResolved, state.active));
  } catch (e) {
    lcWarn('Label sync ' + replicaKey + ' failed:', e.message);
  }
}

async function teardownReplicas() {
  lcLog('--- teardownReplicas() for call ' + activeReplicaCallId + ' ---');
  const endedCallId = activeReplicaCallId;
  activeReplicaCallId = null;
  replicaSupport = { videoMute: false, hand: false, record: false };
  if (replicaSettleTimer) {
    clearTimeout(replicaSettleTimer);
    replicaSettleTimer = null;
    lcLog('  cleared pending settle timer');
  }
  let removed = 0;
  for (const def of Object.values(REPLICA_DEFS)) {
    try {
      await xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: def.panelId });
      removed++;
      lcLog('  removed replica panel ' + def.panelId);
    } catch (e) {
      lcLog('  no replica panel to remove for ' + def.panelId + ' (already absent)');
    }
  }
  lcLog('  ' + removed + ' replica panel(s) removed; now restoring native controls');
  await restoreNativeFromCall();
  lcLog('--- teardownReplicas() COMPLETE for call ' + endedCallId + ' ---');
}

async function probeCallContext(forCallId) {
  lcLog('Probing call context for call ' + forCallId);

  let inCall = false;
  try {
    const sys = await xapi.Status.SystemUnit.State.System.get();
    inCall = (sys === 'InCall');
    lcLog('  Status.SystemUnit.State.System =', sys, '-> inCall=' + inCall);
  } catch (e) {
    lcWarn('  Status.SystemUnit.State.System read failed:', e.message);
  }

  let confCall = null;
  let confCallSrc = 'none';
  try {
    const calls = await xapi.Status.Conference.Call.get();
    const matched = (calls || []).find(c => String(c.id) === String(forCallId));
    if (matched) {
      confCall = matched;
      confCallSrc = 'matched id=' + forCallId;
    } else if ((calls || []).length > 0) {
      confCall = calls[0];
      confCallSrc = 'fallback first (id=' + calls[0].id + ')';
    }
    lcLog('  Status.Conference.Call: ' + (calls?.length ?? 0) + ' entries, using ' + confCallSrc);
  } catch (e) {
    lcWarn('  Status.Conference.Call read failed:', e.message);
  }

  const caps = confCall?.Capabilities ?? {};
  const handAvail = caps.RaiseHand === 'Available';
  const recordAvail = caps.Recording?.Start === 'Available';
  lcLog('  Capabilities.RaiseHand =', caps.RaiseHand ?? 'missing', '-> hand=' + handAvail);
  lcLog('  Capabilities.Recording.Start =', caps.Recording?.Start ?? 'missing', '-> record=' + recordAvail);

  return {
    videoMute: inCall,
    hand: handAvail,
    record: recordAvail
  };
}

async function handleReplicaVideoMuteClick() {
  const current = await xapi.Status.Video.Input.MainVideoMute.get().catch(() => 'Off');
  const action = (current === 'On') ? 'Unmute' : 'Mute';
  lcLog('Replica click: videoMute (current=' + current + ' action=' + action + ')');
  if (action === 'Unmute') {
    await xapi.Command.Video.Input.MainVideo.Unmute();
  } else {
    await xapi.Command.Video.Input.MainVideo.Mute();
  }
  lcLog('  videoMute command issued; label will refresh via MainVideoMute listener');
}

async function handleReplicaHandClick() {
  if (!activeReplicaCallId) {
    lcWarn('Replica click: hand -- no active call, ignoring');
    return;
  }
  const calls = await xapi.Status.Conference.Call.get().catch(() => []);
  const call = (calls || []).find(c => String(c.id) === String(activeReplicaCallId)) || (calls || [])[0];
  // See computeReplicaState() for the value enumeration; only 'Raised' counts as raised.
  const isActive = (call?.RaiseHand === 'Raised');
  const action = isActive ? 'Lower' : 'Raise';
  lcLog('Replica click: hand (currentRaiseHand=' + (call?.RaiseHand ?? 'unknown') + ' action=' + action + ' callId=' + activeReplicaCallId + ')');
  const args = { CallId: activeReplicaCallId };
  try {
    if (isActive) {
      await xapi.Command.Conference.Hand.Lower(args);
    } else {
      await xapi.Command.Conference.Hand.Raise(args);
    }
    lcLog('  hand ' + action + ' command issued; label will refresh via RaiseHand listener');
  } catch (e) {
    lcError('  hand ' + action + ' command FAILED:', e.message);
  }
}

async function handleReplicaRecordClick() {
  if (!activeReplicaCallId) {
    lcWarn('Replica click: record -- no active call, ignoring');
    return;
  }
  const calls = await xapi.Status.Conference.Call.get().catch(() => []);
  const call = (calls || []).find(c => String(c.id) === String(activeReplicaCallId)) || (calls || [])[0];
  const isRecording = (call?.Recording === 'Recording');
  const action = isRecording ? 'Stop' : 'Start';
  lcLog('Replica click: record (currentRecording=' + (call?.Recording ?? 'unknown') + ' action=' + action + ' callId=' + activeReplicaCallId + ')');
  const args = { CallId: activeReplicaCallId };
  try {
    if (isRecording) {
      await xapi.Command.Conference.Recording.Stop(args);
    } else {
      await xapi.Command.Conference.Recording.Start(args);
    }
    lcLog('  record ' + action + ' command issued; label will refresh via Recording listener');
  } catch (e) {
    lcError('  record ' + action + ' command FAILED:', e.message);
  }
}

/*********************************************************
 * DISCOVERY MODE (Phase 2 instrumentation)
 *
 * Logs comprehensive call context data on every call
 * connect / disconnect event so we can design the
 * production show/hide rules for the custom replica
 * panels (Custom Video Mute / Custom Hand / Custom
 * Record).
 *
 * SAFE: Reads state only. Never sets configs, never
 * invokes Hand.Raise / Recording.Start / Mute commands.
 * No visible side effects on the device.
 *
 * Usage: set config.discoveryMode = true. Run each call
 * scenario (Webex meeting, P2P call, MTRoA Teams CVI)
 * and copy the [disco] log lines from the macro editor
 * console for analysis.
 *
 * Turn off (config.discoveryMode = false) before
 * production deployment.
 *********************************************************/

const DISCO_HIDE_CONFIGS = [
  'AudioMute', 'CameraControls', 'End', 'HdmiPassthrough',
  'JoinGoogleMeet', 'JoinMicrosoftTeamsCVI', 'JoinMicrosoftTeamsDirectGuestJoin',
  'JoinWebex', 'JoinZoom', 'Keypad', 'LayoutControls',
  'MidCallControls', 'MusicMode', 'ParticipantList',
  'SelfviewControls', 'Start', 'VideoMute', 'Webcam'
];

let discoveryCallSettleTimer = null;
let discoveryLastCallId = null;

async function initDiscoveryMode() {
  console.log('================================================');
  console.log('= [disco] DISCOVERY MODE ACTIVE');
  console.log('= [disco] Reads state only -- no commands fired.');
  console.log('================================================');

  await dumpHideConfigs();
  await dumpVideoMuteState();
  await dumpFullCallContext('STARTUP');

  try {
    xapi.Status.Call.on(handleDiscoveryCallEvent);
    console.log('[disco] Listener registered: Status.Call');
  } catch (e) {
    console.warn('[disco] Could not register Status.Call listener:', e.message);
  }

  if (isMTR) {
    try {
      xapi.Status.MicrosoftTeams.Calling.InCall.on(handleDiscoveryMTRCallEvent);
      console.log('[disco] Listener registered: MicrosoftTeams.Calling.InCall');
    } catch (e) {
      console.warn('[disco] Could not register MTR call listener:', e.message);
    }
  }

  console.log('[disco] Discovery listeners armed. Place / receive a call to capture context.');
}

function handleDiscoveryCallEvent(event) {
  const { Status, id, ghost } = event;

  if (ghost) {
    console.log('================================================');
    console.log('= [disco] CALL ENDED -- id:', id);
    console.log('================================================');
    dumpFullCallContext('CALL_ENDED').catch(e => console.warn('[disco] dump failed:', e.message));
    discoveryLastCallId = null;
    return;
  }

  if (Status === 'Connected' && id !== discoveryLastCallId) {
    discoveryLastCallId = id;
    console.log('================================================');
    console.log('= [disco] CALL CONNECTED -- id:', id);
    console.log('= [disco] Settling 1500ms before context dump...');
    console.log('================================================');

    if (discoveryCallSettleTimer) clearTimeout(discoveryCallSettleTimer);
    discoveryCallSettleTimer = unrefTimer(setTimeout(() => {
      dumpFullCallContext('CALL_CONNECTED id=' + id).catch(e => console.warn('[disco] dump failed:', e.message));
    }, 1500));
    return;
  }

  if (Status) {
    console.log('[disco] Status.Call change -- id:', id, 'status:', Status);
  }
}

function handleDiscoveryMTRCallEvent(inCall) {
  console.log('[disco] MicrosoftTeams.Calling.InCall:', inCall);
  if (inCall === 'True') {
    console.log('================================================');
    console.log('= [disco] MTR TEAMS CALL ACTIVE');
    console.log('= [disco] Settling 2000ms before context dump...');
    console.log('================================================');

    if (discoveryCallSettleTimer) clearTimeout(discoveryCallSettleTimer);
    discoveryCallSettleTimer = unrefTimer(setTimeout(() => {
      dumpFullCallContext('MTR_TEAMS_INCALL').catch(e => console.warn('[disco] dump failed:', e.message));
    }, 2000));
  } else if (inCall === 'False') {
    console.log('================================================');
    console.log('= [disco] MTR TEAMS CALL ENDED');
    console.log('================================================');
  }
}

async function dumpHideConfigs() {
  console.log('--- [disco] Current UserInterface.Features.Call.* configs ---');
  for (const name of DISCO_HIDE_CONFIGS) {
    try {
      const value = await xapi.Config.UserInterface.Features.Call[name].get();
      console.log('[disco] Config.UserInterface.Features.Call.' + name + ':', value);
    } catch (e) {
      console.log('[disco] Config.UserInterface.Features.Call.' + name + ': UNAVAILABLE -', e.message);
    }
  }
  try {
    const hideAll = await xapi.Config.UserInterface.Features.HideAll.get();
    console.log('[disco] Config.UserInterface.Features.HideAll:', hideAll);
  } catch (e) {
    console.log('[disco] Config.UserInterface.Features.HideAll: UNAVAILABLE -', e.message);
  }
}

async function dumpVideoMuteState() {
  console.log('--- [disco] Video mute / outgoing video state probes ---');
  const probePaths = [
    ['Status.Video.Input.MainVideoMute', () => xapi.Status.Video.Input.MainVideoMute.get()],
    ['Status.Conference.DoNotDisturb', () => xapi.Status.Conference.DoNotDisturb.get()],
    ['Status.Video.Selfview.Mode', () => xapi.Status.Video.Selfview.Mode.get()]
  ];
  for (const [label, fn] of probePaths) {
    try {
      const v = await fn();
      console.log('[disco] ' + label + ':', JSON.stringify(v));
    } catch (e) {
      console.log('[disco] ' + label + ': UNAVAILABLE -', e.message);
    }
  }
}

async function dumpFullCallContext(label) {
  console.log('===== [disco] CONTEXT DUMP --', label, '=====');

  await dumpStatusPath('Status.Call', () => xapi.Status.Call.get());
  await dumpStatusPath('Status.Conference', () => xapi.Status.Conference.get());
  await dumpStatusPath('Status.Conference.Call', () => xapi.Status.Conference.Call.get());
  await dumpStatusPath('Status.Conference.DoNotDisturb', () => xapi.Status.Conference.DoNotDisturb.get());
  await dumpStatusPath('Status.SystemUnit.State', () => xapi.Status.SystemUnit.State.get());

  await dumpStatusPath('Status.Video.Input.MainVideoMute', () => xapi.Status.Video.Input.MainVideoMute.get());
  await dumpStatusPath('Status.Audio.Microphones.Mute', () => xapi.Status.Audio.Microphones.Mute.get());

  if (isMTR) {
    await dumpStatusPath('Status.MicrosoftTeams', () => xapi.Status.MicrosoftTeams.get());
  }

  console.log('===== [disco] END CONTEXT DUMP --', label, '=====');
}

async function dumpStatusPath(label, fn) {
  try {
    const value = await fn();
    console.log('[disco] ' + label + ':', JSON.stringify(value, null, 2));
  } catch (e) {
    console.log('[disco] ' + label + ': UNAVAILABLE -', e.message);
  }
}
