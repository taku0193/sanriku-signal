import { useEffect, useState } from "react";
import type { PropsWithChildren, ReactNode } from "react";

const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");

interface CoastHeroProps {
  poster: string;
  source?: string;
  brand: ReactNode;
  entryForm: ReactNode;
}

export default function CoastHero({ poster, source, brand, entryForm, children }: PropsWithChildren<CoastHeroProps>) {
  const [reducedMotion, setReducedMotion] = useState(motionPreference.matches);
  const [hasFrame, setHasFrame] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [sceneryOnly, setSceneryOnly] = useState(false);

  useEffect(() => {
    function updatePreference(event: MediaQueryListEvent) {
      setReducedMotion(event.matches);
      setHasFrame(false);
    }
    motionPreference.addEventListener("change", updatePreference);
    return () => motionPreference.removeEventListener("change", updatePreference);
  }, []);

  const showVideo = source && !reducedMotion && !videoFailed;
  return (
    <section className="coast-hero" data-scenery-only={sceneryOnly} aria-labelledby="page-title">
      <div className="coast-backdrop" aria-hidden="true">
        <img src={poster} alt="" width={1280} height={720} fetchPriority="high" />
        {showVideo && (
          <video className={hasFrame ? "coast-video coast-video-ready" : "coast-video"}
            src={source} autoPlay loop muted playsInline preload="metadata" disablePictureInPicture
            onPlaying={() => setHasFrame(true)} onError={() => setVideoFailed(true)} />
        )}
      </div>
      <div id="coast-copy" className="coast-copy" aria-hidden={sceneryOnly}>
        <div className="coast-brand"><div className="wide header-inner">{brand}</div></div>
        <div className="welcome wide">{children}</div>
      </div>
      <button type="button" className="coast-view-toggle" aria-label="背景の文字を隠す"
        aria-controls="coast-copy" aria-pressed={sceneryOnly} onClick={() => setSceneryOnly((current) => !current)} />
      <div className="entry-panel">{entryForm}</div>
    </section>
  );
}
