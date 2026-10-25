import test from "node:test";
import assert from "node:assert/strict";
import { generateEditorialDraft } from "../src/services/EditorialDraftAgent.js";

const candidate = {
  title: "A source headline",
  description: "A short source summary.",
  sourceName: "Example News",
  url: "https://news.example/story",
  publishedAt: "2026-10-08T10:00:00.000Z",
  category: "India",
  language: "en"
};

const draft = {
  title: "An original headline",
  summary: "A concise original summary.",
  body: Array.from({ length: 520 }, (_, index) => `supported${index}`).join(" "),
  category: "India",
  verificationNotes: "Verify the primary claim and date against the source."
};

function successfulResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("AI draft generation fails clearly without a server-side OpenRouter API key", async () => {
  let called = false;
  await assert.rejects(
    () => generateEditorialDraft(candidate, {
      apiKey: "",
      fetchImpl: async () => { called = true; }
    }),
    /Configure OPENROUTER_API_KEY in server\/\.env/
  );
  assert.equal(called, false);
});

test("AI draft generation sends only source metadata and validates the generated JSON", async () => {
  let request;
  const result = await generateEditorialDraft(candidate, {
    apiKey: "test-secret",
    model: "test-model",
    fetchImpl: async (url, options) => {
      request = { url, ...options, body: JSON.parse(options.body) };
      return successfulResponse(draft);
    }
  });

  assert.equal(request.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer test-secret");
  assert.equal(request.headers["X-Title"], "KraantiInfo");
  assert.equal(request.body.model, "test-model");
  assert.match(request.body.messages[0].content, /do not reproduce it, closely paraphrase it/);
  assert.match(request.body.messages[1].content, /A short source summary/);
  assert.deepEqual(result, { ...draft, model: "test-model" });
});

test("AI draft generation retries malformed router output with a configured fallback model", async () => {
  const requests = [];
  const result = await generateEditorialDraft(candidate, {
    apiKey: "test-secret",
    model: "router-model",
    fallbackModels: ["fallback-model"],
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body.model);
      return successfulResponse(requests.length <= 2 ? { ...draft, category: "Unknown" } : draft);
    }
  });

  assert.deepEqual(requests, ["router-model", "router-model", "fallback-model"]);
  assert.equal(result.model, "fallback-model");
});

test("AI draft generation accepts a JSON object wrapped in a markdown code fence", async () => {
  const result = await generateEditorialDraft(candidate, {
    apiKey: "test-secret",
    fallbackModels: [],
    fetchImpl: async () => new Response(JSON.stringify({
      model: "fenced-model",
      choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`` } }]
    }), { status: 200 })
  });
  assert.deepEqual(result, { ...draft, model: "fenced-model" });
});

test("AI draft generation rejects invalid categories and malformed output", async () => {
  await assert.rejects(
    () => generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      fetchImpl: async () => successfulResponse({ ...draft, category: "Unsupported" })
    }),
    /incomplete article draft/
  );
  await assert.rejects(
    () => generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { content: "not json" } }]
      }), { status: 200 })
    }),
    /invalid article draft/
  );
});

test("AI provider authentication and quota errors are surfaced without exposing the key", async () => {
  await assert.rejects(
    () => generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      fetchImpl: async () => new Response("", { status: 401 })
    }),
    /OpenRouter rejected the server API key/
  );
  await assert.rejects(
    () => generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      fetchImpl: async () => new Response("", { status: 429 })
    }),
    /OpenRouter rate limit or quota/
  );
});

test("free-model rate limits stop immediately without spending requests on fallback models", async () => {
  const requests = [];
  await assert.rejects(
    () => generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      model: "google/gemma-4-31b-it:free",
      fallbackModels: ["google/gemma-4-26b-a4b-it:free"],
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body).model);
        return new Response("", { status: 429 });
      }
    }),
    /free-model limit/,
  );
  assert.deepEqual(requests, ["google/gemma-4-31b-it:free"]);
});

