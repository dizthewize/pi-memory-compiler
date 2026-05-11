/**
 * Generic LLM client supporting OpenAI-compatible APIs.
 * Used for LLM-powered flush and compile when config.mode === "llm".
 */

import { loadConfig } from "./config.js";

export interface LLMConfig {
  provider: "openai" | "ollama" | "ollama-cloud" | "opencode-go" | "anthropic" | "custom";
  apiKey?: string;
  model: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  costUsd?: number;
}

function getDefaultBaseUrl(provider: string): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "anthropic":
      return "https://api.anthropic.com/v1";
    case "ollama":
      return "http://localhost:11434/v1";
    case "ollama-cloud":
      return "https://ollama.com/v1";
    case "opencode-go":
      return "https://opencode.ai/zen/go/v1";
    default:
      return "";
  }
}

function estimateCost(promptTokens: number, completionTokens: number, model: string): number {
  // Rough estimates per 1K tokens
  const rates: Record<string, { input: number; output: number }> = {
    "gpt-4o": { input: 0.0025, output: 0.01 },
    "gpt-4o-mini": { input: 0.00015, output: 0.0006 },
    "claude-3-5-sonnet": { input: 0.003, output: 0.015 },
    "claude-3-haiku": { input: 0.00025, output: 0.00125 },
  };
  const rate = rates[model] || { input: 0.001, output: 0.002 };
  return (promptTokens / 1000) * rate.input + (completionTokens / 1000) * rate.output;
}

function resolveApiKey(provider: string, configKey?: string): string {
  if (configKey) return configKey;

  const envMap: Record<string, string> = {
    "opencode-go": "OPENCODE_API_KEY",
    "ollama-cloud": "OLLAMA_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
  };

  const envVar = envMap[provider];
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }

  // Generic fallback
  if (process.env.LLM_API_KEY) return process.env.LLM_API_KEY;

  return "";
}

export async function callLLM(
  prompt: string,
  systemPrompt?: string,
  llmConfig?: LLMConfig
): Promise<LLMResponse> {
  const config = loadConfig();
  const llm = llmConfig || (config as any).llm;

  if (!llm) {
    throw new Error("LLM config not found. Set llm.provider and llm.model in config.json, plus the API key via config or environment variable.");
  }

  const baseUrl = llm.baseUrl || getDefaultBaseUrl(llm.provider);
  const model = llm.model;
  const maxTokens = llm.maxTokens || 4000;
  const temperature = llm.temperature ?? 0.3;
  const apiKey = resolveApiKey(llm.provider, llm.apiKey);

  if (!apiKey && llm.provider !== "ollama") {
    throw new Error(`No API key found for provider '${llm.provider}'. Set it in config.json (llm.apiKey) or as an environment variable (${["OPENCODE_API_KEY", "OLLAMA_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].join(", ")}, or LLM_API_KEY).`);
  }

  if (llm.provider === "anthropic") {
    return callAnthropic(baseUrl, apiKey, model, prompt, systemPrompt, maxTokens, temperature);
  }

  // OpenAI-compatible path (covers OpenAI, Ollama, OpenCode Go, and most local proxies)
  return callOpenAICompatible(baseUrl, apiKey, model, prompt, systemPrompt, maxTokens, temperature);
}

async function callOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens = 4000,
  temperature = 0.3
): Promise<LLMResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey ? `Bearer ${apiKey}` : "",
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  const usage = data.usage;

  return {
    content,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        }
      : undefined,
    costUsd: usage
      ? estimateCost(usage.prompt_tokens, usage.completion_tokens, model)
      : undefined,
  };
}

async function callAnthropic(
  baseUrl: string,
  apiKey: string,
  model: string,
  prompt: string,
  systemPrompt?: string,
  maxTokens = 4000,
  temperature = 0.3
): Promise<LLMResponse> {
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt || undefined,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data.content?.[0]?.text || "";
  const usage = data.usage;

  return {
    content,
    usage: usage
      ? {
          promptTokens: usage.input_tokens,
          completionTokens: usage.output_tokens,
          totalTokens: usage.input_tokens + usage.output_tokens,
        }
      : undefined,
    costUsd: usage
      ? estimateCost(usage.input_tokens, usage.output_tokens, model)
      : undefined,
  };
}

/**
 * Parse structured article blocks from LLM output.
 * Expected format:
 * ---ARTICLE---
 * path: concepts/react.md
 * title: React
 * content: |
 *   [markdown]
 * ---END---
 */
export function parseArticleBlocks(text: string): Array<{ path: string; title: string; content: string }> {
  const articles: Array<{ path: string; title: string; content: string }> = [];
  const regex = /---ARTICLE---\n([\s\S]*?)---END---/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const pathMatch = block.match(/^path:\s*(.+)$/m);
    const titleMatch = block.match(/^title:\s*(.+)$/m);
    const contentMatch = block.match(/^content:\s*\|\n([\s\S]*)/m);

    if (pathMatch && titleMatch && contentMatch) {
      articles.push({
        path: pathMatch[1].trim(),
        title: titleMatch[1].trim(),
        content: contentMatch[1].trim(),
      });
    }
  }

  return articles;
}
