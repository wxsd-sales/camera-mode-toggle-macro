/********************************************************
 *
 * Unified Camera Mode Buttons Macro
 * for Cisco RoomOS and MTRoA Devices
 *
 * Version: 1-0-0
 * Released: 04/15/26
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

  // Icon per mode button. Available: Briefing, Camera, Concierge,
  // Helpdesk, Hvac, Info, Input, Language, Laptop, Lightbulb,
  // MediaPlayer, Microphone, Moderator, Plus, Proximity, Record,
  // Sliders, Spinner, Tv, Webex
  icons: {
    speakerTrack: 'Helpdesk',
    presenterTrack: 'Laptop',
    manual: 'Camera'
  },

  // Log device capability details at startup.
  diagnostics: true
};

/*********************************************************
 * CONSTANTS AND STATE
 *********************************************************/

const MANUAL_PAGE_ID = 'camManualPage';
const CAM_SELECT_ID = 'camSelectBtn';
const PTZ_PAD_ID = 'camPTZPadBtn';
const ZOOM_IN_ID = 'camZoomInBtn';
const ZOOM_OUT_ID = 'camZoomOutBtn';

const STALE_PANELS = [
  'cameraModeToggle',
  'cameraModeToggleMTR',
  'cameraModeButtons',
  'camPTZPanel'
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

  await buildAllPanels();
  await syncState();

  xapi.Event.UserInterface.Extensions.Panel.Clicked.on(handlePanelClicked);
  xapi.Event.UserInterface.Extensions.Widget.Action.on(processWidgetAction);
  xapi.Event.UserInterface.Extensions.Page.Action.on(handlePageAction);
  xapi.Status.Video.Input.MainVideoSource.on(value => setCameraSelectWidgetValue(value));

  registerStatusListeners(ptAvailable);
  registerCallListeners();

  if (config.diagnostics) await runDiagnostics();

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
  try {
    await xapi.Status.MicrosoftTeams.Calling.InCall.get();
    return true;
  } catch (e) {
    return false;
  }
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
  console.log('Getting Camera Id for Connecor:', connectorId)
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
  xapi.Command.Video.Input.SetMainVideoSource({ ConnectorId: connectorId });
  const associatedCameraId = await getDetectedCameraId(connectorId);

  if (activeCameraId == associatedCameraId) return

  activeCameraId = associatedCameraId;


  setCameraSelectWidgetValue(associatedCameraId);

}

function setCameraSelectWidgetValue(value) {
  if (ptzCameras.length < 2) return;
  if (isNaN(value)) return;
  console.log('Setting Camera Selection Widget Value To:', value);
  xapi.Command.UserInterface.Extensions.Widget.SetValue({
    WidgetId: CAM_SELECT_ID,
    Value: String(value)
  }).catch(e => console.error('Error setting camera selector value:', e.message));
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



  setTimeout(() => { applyingMode = false; }, 2000);
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
  selfviewTimer = setTimeout(() => {
    xapi.Command.Video.Selfview.Set({ Mode: 'Off' })
      .catch(e => console.log('Could not disable selfview:', e.message));
    selfviewTimer = null;
  }, config.selfviewTimeout);
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
 *********************************************************/

function handlePanelClicked(event) {
  const modeMatch = availableModes.find(m => m.panelId === event.PanelId);
  if (modeMatch) {
    console.log('Mode button clicked:', modeMatch.name);
    applyMode(modeMatch.key);
  }
}

function handlePageAction(event) {
  if (event.PageId === MANUAL_PAGE_ID && event.Type === 'Opened') {
    console.log('Manual PTZ page opened');
    if (currentMode !== 'manual') {
      applyMode('manual');
    }
  }
}

function processWidgetAction(event) {
  const { WidgetId, Type, Value } = event;

  if (WidgetId === CAM_SELECT_ID && Type === 'pressed') {
    activeCameraId = parseInt(Value);
    console.log('Active PTZ camera changed:', activeCameraId);
    changeSource(activeCameraId)
    return;
  }

  if (WidgetId === PTZ_PAD_ID) {
    handlePTZPad(Type, Value);
    return;
  }

  if (WidgetId === ZOOM_IN_ID || WidgetId === ZOOM_OUT_ID) {
    handleZoom(WidgetId, Type);
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
 * UI CONSTRUCTION
 *
 * Builds and saves the Control Panel buttons as XML
 * panel definitions via the xAPI. Each mode gets its
 * own panel entry. Speaker Track and Presenter Track
 * are pageless action buttons; Manual includes a page
 * with PTZ controls.
 *********************************************************/

async function buildAllPanels() {
  for (const mode of availableModes) {
    await saveModeButton(mode);
  }
}

async function saveModeButton(mode) {
  const isActive = (mode.key === currentMode);
  const label = isActive ? ('\u2713 ' + mode.name) : mode.name;
  const icon = config.icons[mode.key] || 'Camera';

  let xml;

  if (mode.key === 'manual' && activeCameraId !== null) {
    xml = buildManualPanelXml(label, icon);
  } else {
    xml = `
    <Extensions>
      <Panel>
        <Location>ControlPanel</Location>
        <Icon>${icon}</Icon>
        <Name>${label}</Name>
        <ActivityType>Custom</ActivityType>
      </Panel>
    </Extensions>`;
  }

  try {
    await xapi.Command.UserInterface.Extensions.Panel.Save(
      { PanelId: mode.panelId },
      xml
    );

    if (mode.key === 'manual' && ptzCameras.length > 1 && activeCameraId !== null) {
      setCameraSelectWidgetValue(activeCameraId);
    }
  } catch (e) {
    console.error('Failed to save mode button', mode.panelId, '-', e.message);
  }
}

function buildManualPanelXml(label, icon) {
  let camSelectorRow = '';
  if (ptzCameras.length > 1) {

    const camValues = ptzCameras.map(({ id, name }) => `<Value><Key>${id}</Key><Name>${name}</Name></Value>`).join('');

    camSelectorRow = `
          <Row>
            <Name>Camera</Name>
            <Widget>
              <WidgetId>${CAM_SELECT_ID}</WidgetId>
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
        <Location>ControlPanel</Location>
        <Icon>${icon}</Icon>
        <Name>${label}</Name>
        <ActivityType>Custom</ActivityType>
        <Page>
          <PageId>${MANUAL_PAGE_ID}</PageId>
          <Name>Camera Controls</Name>${camSelectorRow}
          <Row>
            <Name>PTZ</Name>
            <Widget>
              <WidgetId>camPTZLabelBtn</WidgetId>
              <Name>Pan / Tilt</Name>
              <Type>Text</Type>
              <Options>size=1;fontSize=small;align=center</Options>
            </Widget>
            <Widget>
              <WidgetId>${PTZ_PAD_ID}</WidgetId>
              <Type>DirectionalPad</Type>
              <Options>size=1</Options>
            </Widget>
            <Widget>
              <WidgetId>${ZOOM_IN_ID}</WidgetId>
              <Type>Button</Type>
              <Options>size=1;icon=plus</Options>
            </Widget>
            <Widget>
              <WidgetId>${ZOOM_OUT_ID}</WidgetId>
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
