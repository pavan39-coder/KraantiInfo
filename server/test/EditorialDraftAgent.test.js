import test from "node:test";
import assert from "node:assert/strict";
import { generateEditorialDraft, selectAndGenerateEditorialDraft } from "../src/services/EditorialDraftAgent.js";

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
      geminiApiKey: "",
      fetchImpl: async () => { called = true; }
    }),
    /Configure OPENROUTER_API_KEY or GEMINI_API_KEY/
  );
  assert.equal(called, false);
});

test("AI draft generation falls back to Gemini when OpenRouter's shared free quota is exhausted", async () => {
  const requests = [];
  let geminiRequest;
  const result = await generateEditorialDraft(candidate, {
    apiKey: "openrouter-test-secret",
    geminiApiKey: "gemini-test-secret",
    model: "openrouter/free",
    fallbackModels: ["google/gemma-4-26b-a4b-it:free"],
    fetchImpl: async (url, options) => {
      requests.push(url);
      if (url.includes("openrouter.ai")) {
        return new Response(JSON.stringify({
          error: {
            code: 429,
            message: "Rate limit exceeded: free-models-per-day",
            metadata: { limit_source: "openrouter_free_tier_daily" }
          }
        }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
      geminiRequest = { url, ...options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] }, finishReason: "STOP" }],
        modelVersion: "gemini-3.8-flash"
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });

  assert.deepEqual(requests, [
    "https://openrouter.ai/api/v1/chat/completions",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
  ]);
  assert.equal(geminiRequest.headers["x-goog-api-key"], "gemini-test-secret");
  assert.equal(geminiRequest.body.generationConfig.responseMimeType, "application/json");
  assert.match(geminiRequest.body.contents[0].parts[0].text, /A short source summary/);
  assert.deepEqual(result, { ...draft, model: "gemini-3.8-flash" });
});

test("AI draft generation works with Gemini alone", async () => {
  let requestedUrl;
  const result = await generateEditorialDraft(candidate, {
    apiKey: "",
    geminiApiKey: "gemini-test-secret",
    fetchImpl: async url => {
      requestedUrl = url;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(draft) }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });

  assert.match(requestedUrl, /generativelanguage\.googleapis\.com/);
  assert.deepEqual(result, { ...draft, model: "gemini-3.8-flash" });
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

test("AI draft generation honors the configured OpenRouter free-model router", async () => {
  const previousModel = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_MODEL = "openrouter/free";
  const requests = [];
  try {
    const result = await generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      fallbackModels: [],
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body).model);
        return successfulResponse(draft);
      }
    });

    assert.deepEqual(requests, ["openrouter/free"]);
    assert.equal(result.model, "openrouter/free");
  } finally {
    if (previousModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previousModel;
  }
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
    /OpenRouter .*HTTP 429/
  );
});

test("AI draft generation tries the configured fallback after a free-model rate limit", async () => {
  const requests = [];
  const result = await generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      model: "google/gemma-4-31b-it:free",
      fallbackModels: ["google/gemma-4-26b-a4b-it:free"],
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body).model);
        if (requests.length === 1) return new Response("", { status: 429 });
        return successfulResponse(draft);
      }
    });
  assert.deepEqual(requests, ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"]);
  assert.equal(result.model, "google/gemma-4-26b-a4b-it:free");
});

test("AI draft generation explains when all configured free models are rate limited", async () => {
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
    /OpenRouter returned HTTP 429.*configured fallbacks/i,
  );
  assert.deepEqual(requests, ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"]);
});

test("AI draft generation stops immediately when OpenRouter's shared free daily quota is exhausted", async () => {
  const requests = [];
  await assert.rejects(
    () => generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      geminiApiKey: "",
      model: "openrouter/free",
      fallbackModels: ["google/gemma-4-26b-a4b-it:free"],
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body).model);
        return new Response(JSON.stringify({
          error: {
            code: 429,
            message: "Rate limit exceeded: free-models-per-day",
            metadata: {
              limit_source: "openrouter_free_tier_daily",
              headers: {
                "X-RateLimit-Limit": "50",
                "X-RateLimit-Remaining": "0",
                "X-RateLimit-Reset": "1792800000000"
              }
            }
          }
        }), { status: 429, headers: { "Content-Type": "application/json" } });
      }
    }),
    /daily free-model quota is exhausted.*50 requests per day.*resets at .*UTC.*share this account quota/i
  );
  assert.deepEqual(requests, ["openrouter/free"]);
});

test("AI draft generation tries a fallback for an upstream provider rate limit", async () => {
  const requests = [];
  const result = await generateEditorialDraft(candidate, {
    apiKey: "test-secret",
    model: "openrouter/free",
    fallbackModels: ["google/gemma-4-26b-a4b-it:free"],
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).model);
      if (requests.length === 1) return new Response(JSON.stringify({
        error: {
          code: 429,
          message: "Provider returned error",
          metadata: { provider_name: "Example Provider", provider_code: "429" }
        }
      }), { status: 429, headers: { "Content-Type": "application/json" } });
      return successfulResponse(draft);
    }
  });

  assert.deepEqual(requests, ["openrouter/free", "google/gemma-4-26b-a4b-it:free"]);
  assert.equal(result.model, "google/gemma-4-26b-a4b-it:free");
});

test("AI draft generation moves to the next model after an OpenRouter 502", async () => {
  const requests = [];
  const result = await generateEditorialDraft(candidate, {
    apiKey: "test-secret",
    model: "openrouter/free",
    fallbackModels: ["google/gemma-4-26b-a4b-it:free"],
    fetchImpl: async (_url, options) => {
      const requestedModel = JSON.parse(options.body).model;
      requests.push(requestedModel);
      if (requests.length === 1) return new Response(JSON.stringify({
        error: {
          code: 502,
          message: "Upstream provider is temporarily unavailable",
          metadata: { provider_name: "Example Provider", provider_code: "502" }
        }
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return successfulResponse(draft);
    }
  });

  assert.deepEqual(requests, ["openrouter/free", "google/gemma-4-26b-a4b-it:free"]);
  assert.equal(result.model, "google/gemma-4-26b-a4b-it:free");
});

test("AI draft generation includes a safe provider reason when every model returns 502", async () => {
  await assert.rejects(
    () => generateEditorialDraft(candidate, {
      apiKey: "test-secret",
      model: "nvidia/nemotron-3.5-super-vl:free",
      fallbackModels: [],
      fetchImpl: async () => new Response(JSON.stringify({
        error: {
          code: 502,
          message: "The upstream inference service is temporarily unavailable",
          metadata: { provider_name: "Example Provider", provider_code: "502" }
        }
      }), { status: 502, headers: { "Content-Type": "application/json" } })
    }),
    /status 502 for nvidia\/nemotron-3\.5-super-vl:free from Example Provider \(provider code 502\): The upstream inference service is temporarily unavailable/
  );
});

test("AI story selection tries configured fallbacks after a rate limit", async () => {
  const requests = [];
  const selection = {
    selectedCandidateId: "candidate-1",
    selectionReason: "Fresh and relevant source details.",
    selectionScore: 82
  };
  const result = await selectAndGenerateEditorialDraft([{
    ...candidate,
    _id: "candidate-1",
    description: "A detailed source summary that is long enough to identify the story and support cautious editorial selection."
  }], {
    apiKey: "test-secret",
    model: "primary:free",
    fallbackModels: ["fallback:free"],
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body).model);
      if (requests.length === 1) return new Response("", { status: 429 });
      return successfulResponse(selection);
    }
  });

  assert.deepEqual(requests, ["primary:free", "fallback:free"]);
  assert.deepEqual(result, { ...selection, model: "fallback:free" });
});

