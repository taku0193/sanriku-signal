const INTERVAL_MS = 80;
const CHARACTERS_PER_INTERVAL = 4;
const MAX_FINAL_INTERVALS = 30;

export function createAnswerPreview(signal: AbortSignal, reducedMotion: MediaQueryList, show: (text: string) => void) {
  let target: string[] = [];
  let visible = 0;
  let chunkSize = CHARACTERS_PER_INTERVAL;
  let timer: number | undefined;
  let finish: (() => void) | undefined;

  function cancelTimer() {
    window.clearTimeout(timer);
    timer = undefined;
    finish?.();
    finish = undefined;
  }

  function finishWhenHidden() {
    if (document.hidden && finish) cancelTimer();
  }

  function schedule() {
    if (timer !== undefined || signal.aborted) return;
    if (visible >= target.length) {
      finish?.();
      finish = undefined;
      return;
    }
    timer = window.setTimeout(() => {
      timer = undefined;
      if (signal.aborted) return;
      visible = reducedMotion.matches ? target.length : Math.min(target.length, visible + chunkSize);
      show(target.slice(0, visible).join(""));
      schedule();
    }, INTERVAL_MS);
  }

  signal.addEventListener("abort", cancelTimer, { once: true });
  document.addEventListener("visibilitychange", finishWhenHidden);
  return {
    append(text: string) {
      target.push(...text);
      schedule();
    },
    reset() {
      cancelTimer();
      target = [];
      visible = 0;
      chunkSize = CHARACTERS_PER_INTERVAL;
    },
    complete(answer: string) {
      const shown = target.slice(0, visible).join("");
      if (signal.aborted || reducedMotion.matches || document.hidden || !answer.startsWith(shown)) {
        cancelTimer();
        return Promise.resolve();
      }
      target = [...answer];
      chunkSize = Math.max(CHARACTERS_PER_INTERVAL, Math.ceil((target.length - visible) / MAX_FINAL_INTERVALS));
      return new Promise<void>((resolve) => {
        finish = resolve;
        schedule();
      });
    },
    displayed: () => target.slice(0, visible).join(""),
    dispose() {
      cancelTimer();
      signal.removeEventListener("abort", cancelTimer);
      document.removeEventListener("visibilitychange", finishWhenHidden);
    },
  };
}
