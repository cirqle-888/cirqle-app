"use client";
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
import { IMAGE_EXT_BY_TYPE, MAX_IMAGE_BYTES } from "@/lib/uploads";
import { prepareLogoUpload } from "./actions";

/**
 * Optional: store the client's logo in the app instead of pasting a link.
 * The file goes to storage and its address is put in the card's "Logo link"
 * box; nothing is kept until the card itself is saved.
 */
export function LogoUpload({
  clientId,
  onUploaded,
}: {
  clientId: string;
  onUploaded: (url: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function upload(file: File) {
    if (!IMAGE_EXT_BY_TYPE[file.type]) {
      setNote("Use a PNG, JPG or WebP image.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setNote("That file is over 10 MB. Use a smaller one.");
      return;
    }
    setBusy(true);
    setNote("");
    try {
      const res = await prepareLogoUpload(clientId, file.name, file.type);
      if (!res.ok || !res.data) {
        setNote(res.error || "Upload failed.");
        return;
      }
      const put = await fetch(res.data.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!put.ok) {
        setNote("Storage rejected the file.");
        return;
      }
      onUploaded(res.data.publicUrl);
      setNote("Uploaded. Save the card to keep it.");
    } catch {
      setNote("Upload failed. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <button
        type="button"
        className="studio-button inline-flex items-center gap-2"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <Upload className="h-4 w-4" /> {busy ? "Uploading…" : "Upload logo instead"}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        aria-label="Upload a logo file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload(file);
        }}
      />
      {note && <span className="text-xs text-muted-foreground" role="status">{note}</span>}
    </div>
  );
}
