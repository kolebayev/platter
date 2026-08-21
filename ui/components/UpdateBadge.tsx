import { useEffect, useState } from "react";
import { ArrowDownToLine, Loader2 } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { notifyIfBackground } from "@/lib/notify";
import {
  checkForUpdate,
  dismissVersion,
  installUpdate,
  isDismissed,
  readDismissed,
} from "@/lib/updates";

/** "Update available" in the header, beside the version it replaces.
 *
 * Not a modal on launch: the app is opened to move music, and a dialog in
 * front of that is a tax on every launch after a release. The badge sits where
 * the reader already looks for the version number, and only the click is
 * interruptive. */
export function UpdateBadge() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [open, setOpen] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [fraction, setFraction] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Separate from clearing `update`, which would tear the dialog out of the
  // tree mid-close. The badge goes now, the dialog animates shut behind it.
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    checkForUpdate().then((found) => {
      if (cancelled || !found) return;
      if (isDismissed(readDismissed(), found.version)) return;
      setUpdate(found);
      // The window is usually in front at launch, where the badge is already
      // visible — this is for the case the user started the app and switched
      // away while it was still checking.
      void notifyIfBackground(
        "Platter update available",
        `Version ${found.version} is ready to install.`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update) return null;

  async function install() {
    if (!update) return;
    setInstalling(true);
    setError(null);
    try {
      // Returns only on failure: a success relaunches the process from under
      // this component.
      await installUpdate(update, setFraction);
    } catch (e) {
      setInstalling(false);
      setFraction(null);
      setError(String(e));
    }
  }

  function notNow() {
    if (update) dismissVersion(update.version);
    setOpen(false);
    setHidden(true);
  }

  return (
    <>
      {!hidden && (
        <Button
          // Filled, not ghost, and the only filled control in a header of bare
          // icons — the one thing here that reads as an offer rather than a
          // status. Words rather than the number, because it sits immediately
          // left of `0.1.0 · Alpha` and two version numbers in a row read as
          // one confusing pair; the number is in the tooltip, where it answers
          // the question the label raises instead of competing with it.
          variant="default"
          size="xs"
          title={`Platter ${update.version} is available`}
          onClick={() => setOpen(true)}
        >
          <ArrowDownToLine />
          New version available
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={!installing}>
          <DialogHeader>
            <DialogTitle>Update available</DialogTitle>
            <DialogDescription>
              Platter {update.version} is ready to install. The app restarts
              once it's done.
            </DialogDescription>
          </DialogHeader>

          {update.body && (
            // Release notes come from the GitHub release verbatim. Rendered as
            // plain pre-wrapped text, never as markup: this string arrives over
            // the network, and the one thing the webview must never do is
            // interpret it.
            <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
              {update.body}
            </p>
          )}

          {installing && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {fraction == null && <Loader2 className="size-3.5 animate-spin" />}
                <span>Downloading…</span>
              </div>
              {fraction != null && <Progress value={fraction * 100} />}
            </div>
          )}

          {error && (
            // The DMG on the releases page is the way out of every failure
            // here, and it is worth naming rather than leaving the user with a
            // dead end. No link: opening a browser needs a shell permission
            // this app does not carry.
            <p className="text-sm text-destructive">
              Couldn't install the update: {error}
              <br />
              Download it from the Platter releases page instead.
            </p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={notNow} disabled={installing}>
              Not now
            </Button>
            <Button onClick={install} disabled={installing}>
              {installing ? "Installing…" : "Install and restart"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
