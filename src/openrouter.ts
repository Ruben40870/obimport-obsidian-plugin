import { requestUrl, RequestUrlParam } from "obsidian";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpenRouterChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface OpenRouterChatResponse {
  text: string;
  raw: unknown;
}

export class OpenRouterError extends Error {
  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
    this.body = body;
  }
}

export async function chat(apiKey: string, req: OpenRouterChatRequest): Promise<OpenRouterChatResponse> {
  if (!apiKey) throw new Error("OpenRouter API key is not configured.");
  if (!req.model) throw new Error("Model is required.");

  const params: RequestUrlParam = {
    url: "https://openrouter.ai/api/v1/chat/completions",
    method: "POST",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/Ruben40870/obimport-obsidian-plugin",
      "X-Title": "OBImport",
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.1,
    }),
    throw: false,
  };

  const res = await requestUrl(params);
  if (res.status < 200 || res.status >= 300) {
    throw new OpenRouterError(
      `OpenRouter HTTP ${res.status}`,
      res.status,
      typeof res.text === "string" ? res.text : JSON.stringify(res.json),
    );
  }

  const data = res.json as { choices?: Array<{ message?: { content?: string } }> };
  const text = data?.choices?.[0]?.message?.content ?? "";
  return { text, raw: data };
}

/** Verify a URL is reachable. Returns null if reachable, else error string. */
export async function verifyUrl(url: string): Promise<string | null> {
  if (!url) return "empty url";
  try {
    new URL(url);
  } catch {
    return "malformed url";
  }
  try {
    // GET with small range header — many servers reject HEAD or return 405.
    const res = await requestUrl({
      url,
      method: "GET",
      headers: { Range: "bytes=0-1023", "User-Agent": "Mozilla/5.0 OBImport/0.2" },
      throw: false,
    });
    if (res.status >= 200 && res.status < 400) return null;
    return `http ${res.status}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
