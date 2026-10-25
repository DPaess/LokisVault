// Reads one line of text at a time with PaddleOCR's PP-OCRv5 mobile recognition model (Apache 2.0,
// by the PaddlePaddle authors), run in the browser by ONNX Runtime Web. The model is served from
// this site; the runtime comes from jsDelivr. Nothing is uploaded: crops are read on this device.

const ORT_VERSION = '1.22.0';
const ORT_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js`;
const MODEL_URL = new URL('models/PP-OCRv5_mobile_rec.onnx', import.meta.url).href;
const DICT_URL = new URL('models/PP-OCRv5_mobile_rec.dict.json', import.meta.url).href;

let ready = null;
function loadRuntime() {
  return new Promise((resolve, reject) => {
    if (window.ort) return resolve(window.ort);
    const s = document.createElement('script');
    s.src = ORT_URL;
    s.onload = () => resolve(window.ort);
    s.onerror = () => reject(new Error('could not download the text reader runtime'));
    document.head.append(s);
  });
}

// Loads the runtime, the model and its characters once; later calls reuse them.
export function loadReader() {
  return (ready ??= (async () => {
    const ort = await loadRuntime();
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
    const [session, dict] = await Promise.all([
      ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'] }),
      fetch(DICT_URL).then((r) => {
        if (!r.ok) throw new Error(`model characters HTTP ${r.status}`);
        return r.json();
      }),
    ]);
    return { ort, session, dict };
  })().catch((err) => {
    ready = null;
    throw err;
  }));
}

// Reads the text in box (screenshot coordinates) of an RGBA image. Returns { text, conf }, where
// conf is the mean probability of the characters read (0 to 1).
export async function readLine({ ort, session, dict }, rgba, w, box) {
  const bw = box.x1 - box.x0;
  const bh = box.y1 - box.y0;
  if (bw < 2 || bh < 2) return { text: '', conf: 0 };
  // The model takes the line scaled to 48 px high, BGR, values from -1 to 1.
  const H = 48;
  const W = Math.max(16, Math.min(1600, Math.ceil((bw * H) / bh)));
  const x = new Float32Array(3 * H * W);
  for (let y = 0; y < H; y++) {
    const sy = box.y0 + Math.min(bh - 1, Math.floor(((y + 0.5) * bh) / H));
    for (let xx = 0; xx < W; xx++) {
      const sx = box.x0 + Math.min(bw - 1, Math.floor(((xx + 0.5) * bw) / W));
      const i = (sy * w + sx) * 4;
      const o = y * W + xx;
      x[o] = rgba[i + 2] / 127.5 - 1;
      x[H * W + o] = rgba[i + 1] / 127.5 - 1;
      x[2 * H * W + o] = rgba[i] / 127.5 - 1;
    }
  }
  const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, H, W]) });
  const out = res[session.outputNames[0]];
  const [, steps, classes] = out.dims;
  // Greedy CTC decoding: best class per step, skipping blanks (0) and repeats.
  let text = '';
  let last = -1;
  let sum = 0;
  let n = 0;
  for (let t = 0; t < steps; t++) {
    let best = 0;
    let bv = -Infinity;
    for (let k = 0; k < classes; k++) {
      const v = out.data[t * classes + k];
      if (v > bv) [bv, best] = [v, k];
    }
    if (best !== 0 && best !== last) {
      text += best <= dict.length ? dict[best - 1] : ' ';
      sum += bv;
      n++;
    }
    last = best;
  }
  return { text, conf: n ? sum / n : 0 };
}
