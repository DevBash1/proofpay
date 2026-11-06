// Minimal client for NEAR AI Cloud (OpenAI-compatible, inference runs in TEEs).
// Optional: the verifier works without it, using only its deterministic checks.

const BASE_URL = process.env.NEAR_AI_BASE_URL ?? "https://cloud-api.near.ai/v1";
const MODEL = process.env.NEAR_AI_MODEL ?? "zai-org/GLM-5.1-FP8";

export const llmAvailable = () => Boolean(process.env.NEAR_AI_API_KEY);

export async function chatJson<T>(system: string, user: string): Promise<T | null> {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: `${system}\nReply with a single JSON object and nothing else.` },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    return match ? (JSON.parse(match[0]) as T) : null;
  } catch {
    return null; // callers treat "no answer" as "skipped"
  }
}
