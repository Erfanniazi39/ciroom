import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { appVersion, canUpdate, checkForUpdate, installUpdate, useUpdates } from "@/lib/updates";
import { Button, ProgressBar } from "./ui";

/** Settings → Updates: the running version, Check for updates, Update now. */
export function UpdateSettings() {
  const u = useUpdates();
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { appVersion().then(setVersion); }, []);
  const installed = canUpdate();

  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-fg">CiRoom {version ? `version ${version}` : ""}</div>
          <div className="meta mt-0.5">
            {!installed && (__CIROOM_DEV__ ? "Test version: it updates itself as you change the code." : "Updates work in the installed app.")}
            {installed && u.status === "none" && "You have the latest version."}
            {installed && u.status === "checking" && "Checking…"}
            {installed && u.status === "available" && <span className="text-accent">Version {u.version} is available.</span>}
            {installed && u.status === "downloading" && `Downloading… ${Math.round(u.progress * 100)}%`}
            {installed && u.status === "restarting" && "Installed. Restarting CiRoom…"}
            {installed && u.status === "error" && <span className="text-danger">Couldn't update: {u.error}</span>}
            {installed && u.status === "idle" && "CiRoom checks for updates on its own every few hours."}
          </div>
        </div>
        {installed && (u.status === "available" ? (
          <Button variant="primary" icon={<Download size={16} />} onClick={installUpdate}>Update now</Button>
        ) : (
          <Button icon={<RefreshCw size={16} className={u.status === "checking" ? "animate-spin" : ""} />} disabled={u.status === "checking" || u.status === "downloading" || u.status === "restarting"} onClick={() => checkForUpdate()}>
            Check for updates
          </Button>
        ))}
      </div>
      {u.status === "downloading" && <ProgressBar value={u.progress} />}
      {u.status === "available" && u.notes && (
        <div className="whitespace-pre-line rounded-xl bg-white/[.04] p-3 text-[13px] text-fg-muted">{u.notes}</div>
      )}
    </div>
  );
}
