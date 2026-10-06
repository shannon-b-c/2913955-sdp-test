"use client";

import { useRef, useState } from "react";
import { FolderGit2, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/**
 * Add a repository either by deep-cloning a remote URL or by uploading a zip
 * that contains the repo's .git (at the archive root or one folder down).
 */
export function AddRepoDialog({ onAdded }: { onAdded: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function submitRemote() {
    if (!url.trim()) {
      toast.error("Enter a repository URL first");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/repos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const body = (await res.json()) as { id?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? "failed to add repository");
      toast.success("Cloning repository — this may take a moment");
      setOpen(false);
      setUrl("");
      onAdded(body.id!);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "failed to add repository");
    } finally {
      setBusy(false);
    }
  }

  async function submitZip() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Choose a zip that contains the repository's .git");
      return;
    }
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/repos", { method: "POST", body: form });
      const body = (await res.json()) as { id?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? "upload failed");
      toast.success("Extracting zip — this may take a moment");
      setOpen(false);
      if (fileRef.current) fileRef.current.value = "";
      onAdded(body.id!);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <FolderGit2 className="size-4" /> Add repository
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a repository</DialogTitle>
          <DialogDescription>
            Deep-clone a remote URL, or upload a zip that includes the repo&apos;s{" "}
            <code className="font-mono text-xs">.git</code>.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="remote">
          <TabsList className="w-full">
            <TabsTrigger value="remote" className="flex-1">Clone URL</TabsTrigger>
            <TabsTrigger value="zip" className="flex-1">Upload zip</TabsTrigger>
          </TabsList>
          <TabsContent value="remote" className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="repo-url">Repository URL</Label>
              <Input
                id="repo-url"
                placeholder="https://github.com/DaveGamble/cJSON.git"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && submitRemote()}
              />
            </div>
            <DialogFooter>
              <Button onClick={submitRemote} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <FolderGit2 className="size-4" />}
                Clone and ingest
              </Button>
            </DialogFooter>
          </TabsContent>
          <TabsContent value="zip" className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="repo-zip">Zip archive (includes .git)</Label>
              <Input id="repo-zip" ref={fileRef} type="file" accept=".zip,application/zip" />
            </div>
            <DialogFooter>
              <Button onClick={submitZip} disabled={busy}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                Upload and ingest
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
