// Talking to tauri-plugin-updater, plus the one piece of state the plugin has
// no opinion about: whether the user already said no to this version.
//
// The check runs once per launch rather than on a timer. The feed is a release
// asset on GitHub's CDN, not the API — no rate limit to husband, and a launch
// is the one moment the user is already waiting for the app anyway.

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { log } from "./log";

const DISMISSED_KEY = "platter.updateDismissed";

/** Whether an available version should stay quiet.
 *
 * Keyed on the version rather than a boolean: "not now" means not for 0.2.0,
 * and a user who declined once should still hear about 0.3.0. A stored version
 * older than the one on offer therefore stops suppressing it by itself, with
 * no expiry to tune. */
export function isDismissed(dismissed: string | null, version: string): boolean {
  return dismissed === version;
}

export function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    // Private-mode or a wedged store: worst case the badge reappears. Never a
    // reason to fail the check that produced it.
    return null;
  }
}

export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version);
  } catch {
    // As above — a dismissal that doesn't stick is a smaller problem than a
    // throw inside a click handler.
  }
}

/** The pending update, or null when this build is current.
 *
 * Never throws. The endpoint 404s until the first release carrying a
 * latest.json is published, and a dev build hits that on every single launch —
 * an update check that can break startup would be a poor trade for a feature
 * whose entire job is to be ignorable. */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    const update = await check();
    log.info(update ? `update.available ${update.version}` : "update.current");
    return update;
  } catch (e) {
    log.info(`update.check-failed ${String(e)}`);
    return null;
  }
}

/** Download, install, relaunch. Does not return on success — the process is
 * replaced. `onProgress` receives 0…1, or null while the server sent no
 * Content-Length to divide by. */
export async function installUpdate(
  update: Update,
  onProgress: (fraction: number | null) => void,
): Promise<void> {
  let total = 0;
  let seen = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onProgress(total > 0 ? 0 : null);
        break;
      case "Progress":
        seen += event.data.chunkLength;
        onProgress(total > 0 ? Math.min(seen / total, 1) : null);
        break;
      case "Finished":
        onProgress(1);
        break;
    }
  });
  log.info(`update.installed ${update.version}`);
  await relaunch();
}
