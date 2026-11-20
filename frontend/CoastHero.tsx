import { useEffect, useRef, useState } from "react";
import type { PropsWithChildren } from "react";

const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");

export default function CoastHero({ poster, source, children }: PropsWithChildren<{ poster: string; source?: string }>) {
  const video = useRef<HTMLVideoElement>(null);
  const [reducedMotion, setReducedMotion] = useState(motionPreference.matches);
  const [playing, setPlaying] = useState(false);
  const [hasFrame, setHasFrame] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [sceneryOnly, setSceneryOnly] = useState(false);

  useEffect(() => {
    function updatePreference(event: MediaQueryListEvent) {
      setReducedMotion(event.matches);
      setPlaying(false);
      setHasFrame(false);
    }
    motionPreference.addEventListener("change", updatePreference);
    return () => motionPreference.removeEventListener("change", updatePreference);
  }, []);

  function togglePlayback() {
    const player = video.current;
    if (!player) return;
    if (player.paused) void player.play().catch(() => {});
    else player.pause();
  }

  const showVideo = source && !reducedMotion && !videoFailed;
  return (
    <section className="coast-hero" data-scenery-only={sceneryOnly} aria-labelledby="page-title">
      <div className="coast-backdrop" aria-hidden="true">
        <img src={poster} alt="" width={1280} height={720} fetchPriority="high" />
        {showVideo && (
          <video ref={video} className={hasFrame ? "coast-video coast-video-ready" : "coast-video"}
            src={source} autoPlay loop muted playsInline preload="metadata" disablePictureInPicture
            onPlaying={() => { setPlaying(true); setHasFrame(true); }}
            onPause={() => setPlaying(false)} onError={() => setVideoFailed(true)} />
        )}
      </div>
      <div className="welcome wide">
        <div id="coast-copy" className="coast-copy" aria-hidden={sceneryOnly}>{children}</div>
        <div className="coast-tools">
          <p id="coast-caption" className="coast-caption" aria-hidden={sceneryOnly}>
            三陸海岸をイメージした生成{showVideo ? "映像" : "画像"}
          </p>
          {showVideo && (
            <button type="button" className="coast-control coast-playback" onClick={togglePlayback}
              aria-label={playing ? "背景動画を一時停止" : "背景動画を再生"}>
              <span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>
              {!sceneryOnly && (playing ? "一時停止" : "再生")}
            </button>
          )}
          <button type="button" className="coast-control coast-view-toggle" aria-label="背景の文字を隠す"
            aria-controls="coast-copy coast-caption" aria-pressed={sceneryOnly}
            title={sceneryOnly ? "文字を表示" : "文字を隠す"} onClick={() => setSceneryOnly((current) => !current)}>
            <span className="coast-view-icon" aria-hidden="true">{sceneryOnly ? "×" : "⛶"}</span>
            {!sceneryOnly && "文字を隠す"}
          </button>
        </div>
      </div>
    </section>
  );
}
