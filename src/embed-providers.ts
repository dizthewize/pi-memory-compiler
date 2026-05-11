import { createHash } from "crypto";
import type { PiMemoryConfig } from "./types.js";

export interface EmbedProvider {
  name: string;
  dim: number;
  embed(text: string): Promise<Float32Array>;
}

let transformersPipeline: any = null;

/**
 * Xenova/Transformers.js provider — runs all-MiniLM-L6-v2 locally.
 * First call downloads the model (~90MB), subsequent calls are fast.
 */
async function createTransformersProvider(model: string): Promise<EmbedProvider | null> {
  try {
    const { pipeline } = await import("@xenova/transformers");
    const embedder = await pipeline("feature-extraction", model);
    transformersPipeline = embedder;

    return {
      name: `transformers:${model}`,
      dim: 384,
      async embed(text: string): Promise<Float32Array> {
        const output = await embedder(text, { pooling: "mean", normalize: true });
        return new Float32Array(output.data);
      },
    };
  } catch (err) {
    console.log(`  Transformers.js not available (${(err as Error).message})`);
    return null;
  }
}

/**
 * Ollama provider — uses local Ollama server.
 * Model must be pulled first: ollama pull nomic-embed-text
 */
async function createOllamaProvider(baseUrl: string, model: string): Promise<EmbedProvider | null> {
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/api/embeddings`;
    const test = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ model, prompt: "test" }),
    });
    if (!test.ok) throw new Error(`Ollama returned ${test.status}`);

    const testJson = await test.json();
    const dim = testJson.embedding?.length ?? 768;

    return {
      name: `ollama:${model}`,
      dim,
      async embed(text: string): Promise<Float32Array> {
        const res = await fetch(url, {
          method: "POST",
          body: JSON.stringify({ model, prompt: text }),
        });
        if (!res.ok) throw new Error(`Ollama embed failed: ${res.status}`);
        const json = await res.json();
        return new Float32Array(json.embedding);
      },
    };
  } catch (err) {
    console.log(`  Ollama not available (${(err as Error).message})`);
    return null;
  }
}

/**
 * Deterministic fallback — produces consistent pseudo-embeddings.
 * Used when no real provider is available.
 */
function createDeterministicProvider(dim: number): EmbedProvider {
  return {
    name: "deterministic",
    dim,
    async embed(text: string): Promise<Float32Array> {
      const vec = new Float32Array(dim);
      let seed = 0;
      for (let i = 0; i < text.length; i++) {
        seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
      }
      let state = seed;
      for (let i = 0; i < dim; i++) {
        state = (state * 1664525 + 1013904223) >>> 0;
        vec[i] = (state / 0xffffffff) * 2 - 1;
      }
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      if (norm > 0) {
        for (let i = 0; i < dim; i++) vec[i] /= norm;
      }
      return vec;
    },
  };
}

let activeProvider: EmbedProvider | null = null;

/**
 * Initialize the best available embedding provider.
 * Priority: 1) Transformers.js, 2) Ollama, 3) Deterministic fallback.
 */
export async function initEmbedProvider(config: PiMemoryConfig): Promise<EmbedProvider> {
  if (activeProvider) return activeProvider;

  console.log("Initializing embedding provider...");

  // 1. Try Transformers.js
  const transformers = await createTransformersProvider(config.embeddingModel);
  if (transformers) {
    activeProvider = transformers;
    console.log(`  ✅ Using ${transformers.name} (${transformers.dim}d)`);
    return activeProvider;
  }

  // 2. Try Ollama (local)
  const ollamaModel = config.embeddingModel === "Xenova/all-MiniLM-L6-v2"
    ? "nomic-embed-text"
    : config.embeddingModel;
  const ollama = await createOllamaProvider("http://localhost:11434", ollamaModel);
  if (ollama) {
    activeProvider = ollama;
    console.log(`  ✅ Using ${ollama.name} (${ollama.dim}d)`);
    return activeProvider;
  }

  // 3. Deterministic fallback
  activeProvider = createDeterministicProvider(384);
  console.log(`  ⚠️  Using ${activeProvider.name} (${activeProvider.dim}d) — install Transformers.js or Ollama for real semantic search`);
  return activeProvider;
}

export function getEmbedProvider(): EmbedProvider | null {
  return activeProvider;
}

export function resetEmbedProvider(): void {
  activeProvider = null;
  transformersPipeline = null;
}
