const INTERVAL_MS = 54;
const CHARACTERS_PER_INTERVAL = 4;

export function createAnswerPreview(signal: AbortSignal, reducedMotion: MediaQueryList, show: (text: string) => void) {
  let displayed = "";
  let queued: string[] = [];
  let timer: number | undefined;

  function cancelTimer() {
    window.clearTimeout(timer);
    timer = undefined;
  }

  function schedule() {
    if (timer !== undefined || signal.aborted || !queued.length) return;
    if (reducedMotion.matches) {
      displayed += queued.join("");
      queued = [];
      show(displayed);
      return;
    }
    timer = window.setTimeout(() => {
      timer = undefined;
      if (signal.aborted) return;
      const count = Math.max(CHARACTERS_PER_INTERVAL, Math.ceil(queued.length / 9));
      displayed += queued.splice(0, count).join("");
      show(displayed);
      schedule();
    }, INTERVAL_MS);
  }

  signal.addEventListener("abort", cancelTimer, { once: true });
  return {
    append(text: string) {
      queued.push(...text);
      schedule();
    },
    reset() {
      cancelTimer();
      queued = [];
      displayed = "";
    },
    displayed: () => displayed,
    dispose() {
      cancelTimer();
      signal.removeEventListener("abort", cancelTimer);
    },
  };
}
