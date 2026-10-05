import { mkdir, mkdtemp, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { BrowserRecording, VideoArtifact } from "./types.js";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createRecording(): Promise<BrowserRecording> {
  const root = path.join(os.tmpdir(), "pi-browser-debug", "videos");
  await mkdir(root, { recursive: true });
  return { directory: await mkdtemp(path.join(root, "recording-")), pages: new Map(), stopTracking: () => undefined };
}

export function trackRecording(context: BrowserContext, recording: BrowserRecording): void {
  const cleanup: Array<() => void> = [];
  const onPage = (page: Page): void => {
    if (recording.pages.has(page)) return;
    const entry = { pageId: `page-${recording.pages.size + 1}`, video: page.video(), url: page.url() };
    recording.pages.set(page, entry);
    const updateUrl = (): void => { entry.url = page.url(); };
    page.on("framenavigated", updateUrl);
    page.on("close", updateUrl);
    cleanup.push(() => { page.off("framenavigated", updateUrl); page.off("close", updateUrl); });
  };
  context.on("page", onPage);
  context.pages().forEach(onPage);
  recording.stopTracking = () => {
    context.off("page", onPage);
    cleanup.splice(0).forEach((stop) => stop());
  };
}

export async function finalizeRecording(name: string, recording: BrowserRecording): Promise<{ videos: VideoArtifact[]; errors: Array<{ name: string; message: string }> }> {
  const videos: VideoArtifact[] = [];
  const errors: Array<{ name: string; message: string }> = [];
  for (const entry of recording.pages.values()) {
    try {
      if (!entry.video) throw new Error("Playwright did not provide a video handle.");
      const videoPath = await entry.video.path();
      const file = await stat(videoPath);
      if (!file.isFile() || file.size === 0) throw new Error("Recorded video is missing or empty.");
      videos.push({ name, pageId: entry.pageId, url: entry.url, path: videoPath, type: "video", mimeType: "video/webm", bytes: file.size });
    } catch (error) {
      errors.push({ name, message: `${entry.pageId}: ${errorMessage(error)}` });
    }
  }
  try {
    await writeFile(path.join(recording.directory, "manifest.json"), `${JSON.stringify({ name, videos, errors }, null, 2)}\n`);
  } catch (error) {
    errors.push({ name, message: `Video manifest: ${errorMessage(error)}` });
  }
  return { videos, errors };
}

export async function removeEmptyRecording(recording: BrowserRecording): Promise<void> {
  // rmdir deliberately preserves non-empty directories and any recoverable evidence.
  await rmdir(recording.directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
  });
}
