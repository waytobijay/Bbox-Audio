"use client";

import { EngineStatusBar } from "../Connections";
import { VideoLab } from "../VideoLab";

export function VideoView() {
  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            AI Video Generation
          </h1>
          <p className="mt-1 text-sm text-muted">
            Turn one portrait photo and your narration into a lip-synced talking-head video.
          </p>
        </div>
        <EngineStatusBar kind="video" />
      </header>
      <VideoLab />
    </div>
  );
}
