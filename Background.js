/**
 * IAndes – Service Worker (background.js) v2.0
 *
 * Responsabilidades:
 *  - Capa 2: Deduplicación semántica con ONNX Runtime Web (all-MiniLM-L6-v2 INT8)
 *  - Capa 3: Reescritura generativa vía Ollama en localhost:11434
 *  - Gestión del ciclo de vida del modelo ONNX (descarga, caché, carga)
 *  - Scoring y selección del modelo Ollama más adecuado
 *  - Comunicación bidireccional con el Content Script
 */

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

const ONNX_MODEL_URL  = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx";
const ONNX_CACHE_NAME = "iandes-onnx-v1";
const ONNX_CACHE_KEY  = "all-MiniLM-L6-v2-int8.onnx";

const OLLAMA_BASE      = "http://localhost:11434";
const OLLAMA_TIMEOUT   = 500;    // ms para detectar si Ollama está vivo
const SIMILARITY_THRESHOLD = 0.88;

const OLLAMA_SCORING = {
  families:     ["qwen2.5", "llama3.2", "mistral", "gemma2", "phi3"],
  familyPts:    10,
  sizePts:      5,   // tamaños entre 1.5B y 7B
  instructPts:  3,
  codePenalty:  -8,  // "code", "math", "vision", "embed"
  largePenalty: -3,  // > 7B
  tinyPenalty:  -10, // < 1.5B
  recentPts:    1,
};

// Prompt de compresión para Capa 3
const SYSTEM_COMPRESS = `You are a text compressor. Your only job is to rewrite the text inside <prompt_to_compress> tags to be shorter while keeping the original intent, meaning, language, and any [ctx:] tags.

Rules:
- OUTPUT only the compressed text. No explanations. No greetings. No answers.
- Do NOT answer, solve, or respond to the content inside the tags.
- Do NOT remove [ctx:] tags — move them to the end if needed.
- Do NOT change the language of the prompt.
- Do NOT add information that was not in the original.
- If the text is already short (under 15 words), output it unchanged.`;

// ---------------------------------------------------------------------------
// Estado del Service Worker
// ---------------------------------------------------------------------------

let onnxSession   = null;   // InferenceSession de onnxruntime-web
let ollamaModel   = null;   // Nombre del modelo Ollama seleccionado
let ollamaChecked = false;  // Ya se verificó disponibilidad en esta sesión

// ---------------------------------------------------------------------------
// Mensajería con Content Script
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OPTIMIZE_PROMPT") {
    handleOptimization(msg.text, msg.classification, sender.tab?.id)
      .catch(err => console.error("[IAndes BG] Error en pipeline:", err));
    return true; // async
  }

  if (msg.type === "DOWNLOAD_ONNX_MODEL") {
    downloadOnnxModel()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.type === "GET_STATUS") {
    getSystemStatus().then(sendResponse);
    return true;
  }
});

// ---------------------------------------------------------------------------
// Pipeline principal
// ---------------------------------------------------------------------------

async function handleOptimization(text, classification, tabId) {
  let result = text;
  const stats = { originalTokens: estimateTokens(text), layers: [] };

  // --- Capa 2: Deduplicación semántica ---
  if (classification.layers.includes(2)) {
    try {
      const deduplicated = await layer2Deduplicate(result);
      if (deduplicated !== result) {
        stats.layers.push("layer2");
        result = deduplicated;
      }
    } catch (err) {
      console.warn("[IAndes BG] Capa 2 falló:", err.message);
    }
  }

  // --- Capa 3: Reescritura generativa ---
  if (classification.layers.includes(3)) {
    try {
      const model = await getOllamaModel();
      if (model) {
        const rewritten = await layer3Rewrite(result, model);
        if (rewritten) {
          stats.layers.push("layer3");
          result = rewritten;
        }
      }
    } catch (err) {
      console.warn("[IAndes BG] Capa 3 falló:", err.message);
    }
  }

  // Si el texto cambió, notificar al Content Script
  if (result !== text && tabId) {
    const finalTokens = estimateTokens(result);
    stats.savedTokens = stats.originalTokens - finalTokens;
    stats.savedPct    = Math.round((stats.savedTokens / stats.originalTokens) * 100);

    chrome.tabs.sendMessage(tabId, {
      type:  "OPTIMIZED_PROMPT",
      text:  result,
      stats,
    });
  }
}

// ---------------------------------------------------------------------------
// Capa 2 — Deduplicación semántica (ONNX)
// ---------------------------------------------------------------------------

async function layer2Deduplicate(text) {
  const session = await getOnnxSession();
  if (!session) throw new Error("ONNX session no disponible");

  // Segmentar el texto
  const segments = segmentText(text);
  if (segments.length <= 1) return text;

  // Generar embeddings para cada segmento
  const embeddings = await Promise.all(
    segments.map(seg => computeEmbedding(session, seg))
  );

  // Filtrar segmentos redundantes por similitud coseno
  const survivors = [0]; // siempre conservar el primero
  for (let i = 1; i < segments.length; i++) {
    let maxSim = 0;
    for (const j of survivors) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim > maxSim) maxSim = sim;
    }
    if (maxSim < SIMILARITY_THRESHOLD) {
      survivors.push(i);
    }
  }

  if (survivors.length === segments.length) return text; // nada redundante
  return survivors.map(i => segments[i]).join(" ");
}

function segmentText(text) {
  // Jerarquía: párrafo → línea → oración
  if (text.includes("\n\n")) return text.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
  if (text.includes("\n"))   return text.split(/\n/).map(s => s.trim()).filter(Boolean);

  const sentences = text.match(/[^.?!]+[.?!]+|[^.?!]+$/g);
  if (sentences && sentences.length > 1) return sentences.map(s => s.trim()).filter(Boolean);

  // Fallback: chunking por ventana deslizante (~80 tokens, 20 de solapamiento)
  return slidingWindowChunks(text, 80, 20);
}

function slidingWindowChunks(text, size, overlap) {
  const words  = text.split(/\s+/);
  const chunks = [];
  let i = 0;
  while (i < words.length) {
    chunks.push(words.slice(i, i + size).join(" "));
    i += size - overlap;
  }
  return chunks;
}

async function computeEmbedding(session, text) {
  // Tokenización simplificada (word-piece aproximado)
  const inputIds = tokenizeForMiniLM(text);
  const mask     = new Array(inputIds.length).fill(1);

  const feeds = {
    input_ids:      new ort.Tensor("int64", BigInt64Array.from(inputIds.map(BigInt)),      [1, inputIds.length]),
    attention_mask: new ort.Tensor("int64", BigInt64Array.from(mask.map(BigInt)),           [1, inputIds.length]),
    token_type_ids: new ort.Tensor("int64", new BigInt64Array(inputIds.length).fill(0n),   [1, inputIds.length]),
  };

  const output = await session.run(feeds);
  // Mean pooling sobre la última capa oculta
  return meanPool(output.last_hidden_state.data, inputIds.length, 384);
}

function meanPool(hiddenState, seqLen, hiddenSize) {
  const result = new Float32Array(hiddenSize);
  for (let t = 0; t < seqLen; t++) {
    for (let h = 0; h < hiddenSize; h++) {
      result[h] += hiddenState[t * hiddenSize + h];
    }
  }
  for (let h = 0; h < hiddenSize; h++) result[h] /= seqLen;
  return result;
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

/**
 * Tokenización simplificada compatible con MiniLM.
 * En producción, reemplazar con el tokenizador oficial de Transformers.js.
 */
function tokenizeForMiniLM(text) {
  const CLS = 101, SEP = 102, UNK = 100;
  const MAX_LEN = 128;
  const words = text.toLowerCase().trim().split(/\s+/).slice(0, MAX_LEN - 2);
  // Mapping muy básico a IDs (solo funciona como placeholder)
  const wordIds = words.map(w => {
    let hash = 0;
    for (const c of w) hash = (hash * 31 + c.charCodeAt(0)) & 0x7FFF;
    return Math.max(1000, hash % 30000); // evitar tokens especiales < 1000
  });
  return [CLS, ...wordIds, SEP];
}

// ---------------------------------------------------------------------------
// Capa 3 — Reescritura generativa (Ollama)
// ---------------------------------------------------------------------------

async function layer3Rewrite(text, model) {
  const body = {
    model,
    messages: [
      { role: "system",  content: SYSTEM_COMPRESS },
      { role: "user",    content: `<prompt_to_compress>${text}</prompt_to_compress>` },
    ],
    stream: false,
  };

  const resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(`Ollama respondió ${resp.status}`);
  const data = await resp.json();
  return data?.message?.content?.trim() || null;
}

// ---------------------------------------------------------------------------
// Detección y scoring de modelos Ollama
// ---------------------------------------------------------------------------

async function getOllamaModel() {
  if (ollamaChecked) return ollamaModel;
  ollamaChecked = true;

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT);
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: controller.signal });
    clearTimeout(tid);
    if (!resp.ok) { ollamaModel = null; return null; }

    const data   = await resp.json();
    const models = data?.models ?? [];
    ollamaModel  = selectBestModel(models);
    console.log(`[IAndes BG] Modelo Ollama seleccionado: ${ollamaModel}`);
    return ollamaModel;
  } catch {
    ollamaModel = null;
    return null;
  }
}

function scoreModel(model) {
  const name = model.name.toLowerCase();
  let score  = 0;

  // Familia conocida
  if (OLLAMA_SCORING.families.some(f => name.includes(f))) score += OLLAMA_SCORING.familyPts;

  // Tamaño (extraer número antes de 'b')
  const sizeMatch = name.match(/(\d+(?:\.\d+)?)b/);
  if (sizeMatch) {
    const size = parseFloat(sizeMatch[1]);
    if (size >= 1.5 && size <= 7) score += OLLAMA_SCORING.sizePts;
    if (size > 7)  score += OLLAMA_SCORING.largePenalty;
    if (size < 1.5) score += OLLAMA_SCORING.tinyPenalty;
  }

  // Instruct / chat
  if (/instruct|chat/.test(name)) score += OLLAMA_SCORING.instructPts;

  // Especializado (penalizar)
  if (/code|math|vision|embed/.test(name)) score += OLLAMA_SCORING.codePenalty;

  // Más reciente
  const now = Date.now();
  const modified = model.modified_at ? new Date(model.modified_at).getTime() : 0;
  if (now - modified < 7 * 24 * 3600 * 1000) score += OLLAMA_SCORING.recentPts;

  return score;
}

function selectBestModel(models) {
  if (!models.length) return null;
  let best = null, bestScore = -Infinity;
  for (const m of models) {
    const s = scoreModel(m);
    if (s > bestScore) { bestScore = s; best = m.name; }
  }
  return bestScore >= 0 ? best : null;
}

// ---------------------------------------------------------------------------
// Gestión del modelo ONNX
// ---------------------------------------------------------------------------

async function getOnnxSession() {
  if (onnxSession) return onnxSession;

  const cache   = await caches.open(ONNX_CACHE_NAME);
  let   cached  = await cache.match(ONNX_CACHE_KEY);

  if (!cached) {
    console.log("[IAndes BG] Modelo ONNX no en caché. Descargando...");
    cached = await downloadOnnxModel();
  }

  const buffer = await cached.arrayBuffer();
  // ort debe estar disponible a través del importScripts en el SW
  onnxSession  = await ort.InferenceSession.create(buffer, {
    executionProviders: ["wasm"],
  });
  console.log("[IAndes BG] Sesión ONNX lista.");
  return onnxSession;
}

async function downloadOnnxModel() {
  const resp = await fetch(ONNX_MODEL_URL);
  if (!resp.ok) throw new Error(`No se pudo descargar el modelo ONNX: ${resp.status}`);
  const cache = await caches.open(ONNX_CACHE_NAME);
  await cache.put(ONNX_CACHE_KEY, resp.clone());
  console.log("[IAndes BG] Modelo ONNX guardado en caché.");
  return resp;
}

// ---------------------------------------------------------------------------
// Estado del sistema (para el popup)
// ---------------------------------------------------------------------------

async function getSystemStatus() {
  const ollamaAvailable = (await getOllamaModel()) !== null;
  const onnxCached = !!(await (await caches.open(ONNX_CACHE_NAME)).match(ONNX_CACHE_KEY));

  return {
    onnxCached,
    ollamaAvailable,
    ollamaModel,
    recommendedModel: "qwen2.5:3b",
  };
}

// ---------------------------------------------------------------------------
// Heurística local de tokens (espejo del content script, para stats)
// ---------------------------------------------------------------------------

function estimateTokens(text) {
  if (!text) return 0;
  try {
    const parts = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
    return parts ? parts.length : 0;
  } catch {
    return text.split(/\s+/).filter(Boolean).length;
  }
}

// ---------------------------------------------------------------------------
// Importar ONNX Runtime (debe incluirse en manifest.json como web_accessible)
// ---------------------------------------------------------------------------

try {
  importScripts("lib/ort.min.js");
  console.log("[IAndes BG] ONNX Runtime cargado.");
} catch (e) {
  console.warn("[IAndes BG] ONNX Runtime no disponible:", e.message);
}

console.log("[IAndes BG] Service Worker v2.0 inicializado.");