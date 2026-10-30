import { config } from './config.ts';

/**
 * Swappable text model. `fake` is deterministic and offline (mock mode default);
 * ai.ts uses its own heuristics for it rather than calling complete().
 */
export interface LlmProvider {
  readonly name: string;
  readonly fake: boolean;
  complete(system: string, user: string, maxTokens?: number): Promise<string>;
}

const TIMEOUT_MS = 45_000;

class FakeProvider implements LlmProvider {
  readonly name = 'fake (deterministic)';
  readonly fake = true;
  async complete(): Promise<string> {
    throw new Error('The fake provider has no free-form completion; ai.ts handles it with heuristics');
  }
}

class AnthropicProvider implements LlmProvider {
  readonly fake = false;
  constructor(
    private key: string,
    private model: string,
  ) {}
  get name() {
    return `anthropic (${this.model})`;
  }
  async complete(system: string, user: string, maxTokens = 800): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { content: { type: string; text?: string }[] };
    return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  }
}

/** Any OpenAI-compatible chat endpoint: OpenAI, Ollama, LM Studio, vLLM, OpenRouter... */
class OpenAiCompatibleProvider implements LlmProvider {
  readonly fake = false;
  constructor(
    private baseUrl: string,
    private key: string,
    private model: string,
  ) {}
  get name() {
    return `openai-compatible (${this.model})`;
  }
  async complete(system: string, user: string, maxTokens = 800): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message.content.trim() ?? '';
  }
}

function build(): LlmProvider {
  const { provider, anthropicKey, anthropicModel, openaiBaseUrl, openaiKey, openaiModel } = config.llm;
  if (provider === 'anthropic' && anthropicKey) return new AnthropicProvider(anthropicKey, anthropicModel);
  if (provider === 'openai') return new OpenAiCompatibleProvider(openaiBaseUrl, openaiKey, openaiModel);
  if (provider !== 'fake') console.error(`[llm] LLM_PROVIDER=${provider} is missing credentials, using the fake provider`);
  return new FakeProvider();
}

export const llm: LlmProvider = build();
