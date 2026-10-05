// Minimal Web Audio fake for headless AudioManager tests. Records every node
// built and every source started; no real audio.

export function installFakeAudio() {
  const sources = [];
  const nodes = [];
  const param = (v = 0) => ({ value: v, setTargetAtTime() {} });
  const node = (kind, extra = {}) => {
    const n = {
      kind,
      connections: [],
      connect(to) { this.connections.push(to); return to; },
      disconnect() { this.connections = []; },
      ...extra,
    };
    nodes.push(n);
    return n;
  };
  class FakeAudioContext {
    constructor() {
      this.state = "running";
      this.currentTime = 0;
      this.destination = node("destination");
      this.listener = {
        positionX: param(), positionY: param(), positionZ: param(),
        forwardX: param(), forwardY: param(), forwardZ: param(-1),
        upX: param(), upY: param(1), upZ: param(),
      };
    }
    createGain() { return node("gain", { gain: param(1), context: this }); }
    createStereoPanner() { return node("stereo", { pan: param(0) }); }
    createPanner() {
      return node("panner", { positionX: param(), positionY: param(), positionZ: param() });
    }
    createBufferSource() {
      const s = node("source", {
        buffer: null, loop: false, started: false, stopped: false, onended: null,
        start() { this.started = true; sources.push(this); },
        stop() { this.stopped = true; },
      });
      return s;
    }
    async decodeAudioData() { return { duration: 1 }; }
    async resume() { this.state = "running"; }
    suspend() { this.state = "suspended"; }
  }
  const hadWindow = globalThis.window != null;
  if (!hadWindow) globalThis.window = {};
  const prevCtx = globalThis.window.AudioContext;
  globalThis.window.AudioContext = FakeAudioContext;
  const fetchWave = async (did) => ({
    id: did, sampleRate: 22050, numChannels: 1, bitsPerSample: 16,
    takeRiffBytes: () => new Uint8Array([1, 2, 3, 4]),
  });
  return {
    fetchWave,
    nodes,
    started: () => sources.filter((s) => s.started),
    lastOfKind: (kind) => [...nodes].reverse().find((n) => n.kind === kind) ?? null,
    uninstall() {
      if (hadWindow) globalThis.window.AudioContext = prevCtx;
      else delete globalThis.window;
    },
  };
}
