type AudioWindow = Window & typeof globalThis & {
  webkitAudioContext?: typeof AudioContext;
};

let audioContext: AudioContext | null = null;

function getAudioContext() {
  if (audioContext) return audioContext;
  const AudioContextConstructor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
  if (!AudioContextConstructor) return null;
  audioContext = new AudioContextConstructor();
  return audioContext;
}

export function primeAnswerReadySound() {
  const context = getAudioContext();
  if (!context || context.state !== "suspended") return;
  void context.resume().catch(() => {
    /* BrowserView may keep audio suspended until a later user gesture. */
  });
}

export async function playAnswerReadySound() {
  const context = getAudioContext();
  if (!context) return;
  if (context.state === "suspended") {
    try {
      await context.resume();
    } catch {
      return;
    }
  }

  const start = context.currentTime + 0.01;
  const master = context.createGain();
  master.gain.setValueAtTime(0.0001, start);
  master.gain.exponentialRampToValueAtTime(0.034, start + 0.025);
  master.gain.exponentialRampToValueAtTime(0.0001, start + 0.62);
  master.connect(context.destination);

  const notes = [
    { frequency: 523.25, offset: 0, duration: 0.32 },
    { frequency: 659.25, offset: 0.18, duration: 0.34 },
  ];

  for (const note of notes) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const noteStart = start + note.offset;
    const noteEnd = noteStart + note.duration;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(note.frequency, noteStart);
    oscillator.frequency.exponentialRampToValueAtTime(note.frequency * 1.004, noteEnd);
    gain.gain.setValueAtTime(0.0001, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.75, noteStart + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);

    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(noteStart);
    oscillator.stop(noteEnd + 0.03);
  }

  window.setTimeout(() => {
    master.disconnect();
  }, 850);
}
