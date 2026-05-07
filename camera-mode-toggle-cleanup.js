/********************************************************
 *
 * camera-mode-toggle Cleanup Utility
 *
 * Standalone single-shot helper that returns a Cisco
 * device to a clean baseline by removing every UI
 * Extensions panel id that the v1 / v2-dev macros could
 * have left behind, and by resetting the native mid-call
 * control configs that v2 may have set to 'Hidden' to
 * back to 'Auto'.
 *
 * Use this between test runs to guarantee a known-good
 * starting state, especially after experimenting with
 * different builds of camera-mode-toggle-v2.js.
 *
 * Usage on the device:
 *   1. Disable / remove camera-mode-toggle.js and
 *      camera-mode-toggle-v2.js (so they don't immediately
 *      re-create their panels right after we wipe them)
 *   2. Upload this file as a new macro
 *   3. Enable it
 *   4. Watch the macro console for the [cleanup] log
 *      lines and the final summary
 *   5. Disable / remove this macro
 *   6. Reinstall camera-mode-toggle-v2.js for the next
 *      test
 *
 * Safe to leave installed; the cleanup runs once on macro
 * start and then the macro idles. To re-run, toggle the
 * macro off then on.
 *
 ********************************************************/

import xapi from 'xapi';

/*********************************************************
 * Panels we will unconditionally remove if present.
 *
 * Includes every id known to be created by v1, v2-dev, and
 * the staging IDs we considered during development. Add
 * any custom panel ids your environment uses below.
 *********************************************************/
const PANELS_TO_REMOVE = [
  // v1 / pre-v1 ids
  'cameraModeToggle',
  'cameraModeToggleMTR',
  'cameraModeButtons',
  'camPTZPanel',

  // v2 base ids (HomeScreenAndCallControls)
  'camBtnSpeakerTrack',
  'camBtnPresenterTrack',
  'camBtnManual',

  // v2 ControlPanel (side flyout) twins added in Option B
  'camBtnSpeakerTrackCP',
  'camBtnPresenterTrackCP',
  'camBtnManualCP',

  // v2 custom mid-call replica panels
  'cmtCustomVideoMute',
  'cmtCustomHand',
  'cmtCustomRecord'
];

/*********************************************************
 * Native UserInterface.Features.Call.<Name> configs that
 * v2 may have set to 'Hidden' during a call. We force them
 * back to 'Auto' so a fresh install starts from the same
 * factory state every operator sees.
 *
 * If the customer is intentionally running with one of
 * these set to 'Hidden' permanently, comment that name out
 * before running this utility.
 *********************************************************/
const NATIVE_CONFIGS_TO_RESET = [
  'VideoMute',
  'MidCallControls'
];

/*********************************************************
 * Pattern sweep: any panel whose id matches one of these
 * regexes will also be removed. Catches dev-time one-off
 * names you may have tried during testing without having
 * to remember each one.
 *
 * Tighten or comment out if you have unrelated panels in
 * the same namespace.
 *********************************************************/
const PANEL_ID_PATTERNS = [
  /^cmt/,          // any custom mid-call toggle / replica we ever shipped
  /^camBtn/,       // any camera-mode button
  /^cameraMode/i,  // legacy roll-up names
  /^camPTZ/        // legacy PTZ panel names
];

/*********************************************************
 * Entry point
 *********************************************************/

run().catch(e => console.error('[cleanup] FATAL:', e.message));

async function run() {
  console.log('======================================================');
  console.log('= camera-mode-toggle CLEANUP UTILITY');
  console.log('= Removes v1 / v2 panels and resets native configs');
  console.log('======================================================');

  const before = await dumpExistingExtensions('before cleanup');
  await removeKnownPanels(before);
  await sweepPatternMatches(before);
  await resetNativeControls();
  await dumpExistingExtensions('after cleanup');

  console.log('======================================================');
  console.log('= [cleanup] DONE');
  console.log('= Disable / remove this macro and reinstall');
  console.log('= camera-mode-toggle-v2.js to start a fresh test.');
  console.log('======================================================');
}

/*********************************************************
 * Step 1 / 4: enumerate everything currently on the device
 * so the operator can see what was there going in.
 *********************************************************/
async function dumpExistingExtensions(label) {
  console.log('--- [cleanup] UI Extensions ' + label + ' ---');
  try {
    const result = await xapi.Command.UserInterface.Extensions.List();
    const panels = result?.Extensions?.Panel ?? [];
    if (panels.length === 0) {
      console.log('  (no panels found)');
      return [];
    }
    console.log('  ' + panels.length + ' panel(s):');
    for (const p of panels) {
      console.log('    PanelId=' + (p.PanelId ?? '?') +
                  '  Location=' + (p.Location ?? '?') +
                  '  Name="' + (p.Name ?? '') + '"');
    }
    return panels;
  } catch (e) {
    console.warn('  could not list extensions:', e.message);
    return [];
  }
}

/*********************************************************
 * Step 2 / 4: remove the known-id list. Each Remove is
 * wrapped because a missing panel returns an error from
 * xAPI and we want the loop to keep going.
 *********************************************************/
async function removeKnownPanels(existing) {
  console.log('--- [cleanup] Removing known panel ids ---');
  const existingIds = new Set((existing || []).map(p => p.PanelId));
  let removed = 0;
  let absent = 0;
  for (const panelId of PANELS_TO_REMOVE) {
    if (!existingIds.has(panelId)) {
      console.log('  skip ' + panelId + ' (not present)');
      absent++;
      continue;
    }
    try {
      await xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: panelId });
      console.log('  REMOVED ' + panelId);
      removed++;
    } catch (e) {
      console.warn('  FAILED to remove ' + panelId + ':', e.message);
    }
  }
  console.log('  summary: ' + removed + ' removed, ' + absent + ' already absent of ' +
              PANELS_TO_REMOVE.length + ' known ids');
}

/*********************************************************
 * Step 3 / 4: pattern sweep. Catches anything that smells
 * like one of our dev panels that the explicit list above
 * happened to miss (typos, abandoned IDs, etc.).
 *********************************************************/
async function sweepPatternMatches(existing) {
  console.log('--- [cleanup] Pattern sweep ---');
  const knownSet = new Set(PANELS_TO_REMOVE);
  const matches = (existing || []).filter(p => {
    if (!p.PanelId) return false;
    if (knownSet.has(p.PanelId)) return false; // already handled in step 2
    return PANEL_ID_PATTERNS.some(rx => rx.test(p.PanelId));
  });
  if (matches.length === 0) {
    console.log('  no additional matches');
    return;
  }
  console.log('  ' + matches.length + ' additional panel(s) match cleanup patterns:');
  for (const p of matches) {
    try {
      await xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: p.PanelId });
      console.log('    REMOVED ' + p.PanelId + ' (Name="' + (p.Name ?? '') + '")');
    } catch (e) {
      console.warn('    FAILED ' + p.PanelId + ':', e.message);
    }
  }
}

/*********************************************************
 * Step 4 / 4: reset native mid-call control overrides.
 * Reads each value first so we can show the before -> after
 * transition (or note that no change was needed).
 *********************************************************/
async function resetNativeControls() {
  console.log('--- [cleanup] Resetting native UserInterface.Features.Call.* to Auto ---');
  for (const name of NATIVE_CONFIGS_TO_RESET) {
    try {
      const before = await xapi.Config.UserInterface.Features.Call[name].get();
      if (before === 'Auto') {
        console.log('  ' + name + ' already Auto');
        continue;
      }
      await xapi.Config.UserInterface.Features.Call[name].set('Auto');
      const after = await xapi.Config.UserInterface.Features.Call[name].get();
      console.log('  ' + name + ' ' + before + ' -> ' + after);
    } catch (e) {
      console.warn('  could not reset ' + name + ':', e.message);
    }
  }
}
