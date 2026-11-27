import { Context } from "@deepseek-ai/cordis";
import Translator from "@deepseek-ai/dsh-experimental-translator";

const maxInputBytes = 32 * 1024;
const maxTextChars = 4_000;
const targetLanguages = new Set(["zh-CN", "zh-TW", "en", "ja"]);
const providers = new Set(["bing", "google"]);
const requestKeys = new Set(["text", "targetLanguage", "provider"]);
const invalidRequest = "LOLICODE_TRANSLATION_INVALID_REQUEST";

async function readRequest() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxInputBytes) throw new Error(invalidRequest);
    chunks.push(chunk);
  }
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, size),
    );
    return JSON.parse(json);
  } catch {
    throw new Error(invalidRequest);
  }
}

// Endpoint overrides are available to tests through this module, never stdin.
export async function translateReasoning(
  request,
  { bingEndpoint, googleEndpoint } = {},
) {
  if (
    !request ||
    typeof request !== "object" ||
    !Object.keys(request).every((key) => requestKeys.has(key)) ||
    typeof request.text !== "string" ||
    request.text.length > maxTextChars ||
    !request.text.trim() ||
    !targetLanguages.has(request.targetLanguage)
  ) {
    throw new Error(invalidRequest);
  }

  const { text, targetLanguage } = request;
  const provider = Object.hasOwn(request, "provider") ? request.provider : "bing";
  if (!providers.has(provider)) throw new Error(invalidRequest);

  const context = new Context();
  try {
    await context
      .plugin(Translator, Translator.Config({ bingEndpoint, googleEndpoint }))
      .await();
    const { translator } = context;
    return await translator.translate(
      translator.resolve({ text, targetLanguage, provider }),
    );
  } finally {
    await context.fiber.dispose();
  }
}

if (import.meta.main) {
  try {
    const result = await translateReasoning(await readRequest());
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const invalid = error?.message === invalidRequest;
    process.stderr.write(
      `${invalid ? invalidRequest : "LOLICODE_TRANSLATION_FAILED"}\n`,
    );
    process.exitCode = invalid ? 2 : 1;
  }
}
