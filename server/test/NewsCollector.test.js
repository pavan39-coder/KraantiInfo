import test from "node:test";
import assert from "node:assert/strict";
import { gdeltRateLimitCooldownMs, mapWithConcurrency, normalizeRecord, normalizedUrl, safeExternalUrl } from "../src/services/NewsCollector.js";

const source = {
  _id: "source-id",
  type: "RSS",
  language: "en",
  country: "in",
  category: "India"
};

test("canonical URLs remove fragments, trailing slashes and common tracking parameters", () => {
  assert.equal(
    normalizedUrl("https://Example.com/story/?utm_source=feed&id=42#top"),
    "https://example.com/story?id=42"
  );
});

test("normalization preserves attribution and keys duplicates by canonical URL", () => {
  const item = normalizeRecord({
    title: "  Sample headline ",
    description: "A short source description.",
    url: "https://news.example/article?utm_medium=rss",
    sourceName: "Example News",
    author: ["Desk", "Reporter"],
    language: "en",
    country: ["in"],
    category: ["India"],
    publishedAt: "2026-10-08T03:00:00Z"
  }, source);

  assert.equal(item.title, "Sample headline");
  assert.equal(item.sourceName, "Example News");
  assert.equal(item.author, "Desk, Reporter");
  assert.equal(item.country, "in");
  assert.equal(item.canonicalUrl, "https://news.example/article");
  assert.equal(item.dedupeKey, normalizeRecord({
    title: "Different provider title",
    url: "https://news.example/article"
  }, source).dedupeKey);
  assert.equal(item.publishedAt.toISOString(), "2026-10-08T03:00:00.000Z");
});

test("normalization also fingerprints matching headlines published on the same day", () => {
  const first = normalizeRecord({
    title: "Shared headline",
    url: "https://news-one.example/story",
    publishedAt: "2026-10-08T03:00:00Z"
  }, source);
  const syndicated = normalizeRecord({
    title: "Shared headline",
    url: "https://news-two.example/story",
    publishedAt: "2026-10-08T08:30:00Z"
  }, { ...source, type: "GDELT" });
  assert.notEqual(first.dedupeKey, syndicated.dedupeKey);
  assert.equal(first.titleFingerprint, syndicated.titleFingerprint);
});

test("normalization skips records with no title or source URL", () => {
  assert.equal(normalizeRecord({ title: "Missing URL" }, source), null);
  assert.equal(normalizeRecord({ url: "https://news.example/article" }, source), null);
});

test("normalization parses GDELT timestamps", () => {
  const item = normalizeRecord({
    title: "GDELT headline",
    url: "https://news.example/gdelt",
    publishedAt: "20261008T031500Z"
  }, { ...source, type: "GDELT" });
  assert.equal(item.publishedAt.toISOString(), "2026-10-08T03:15:00.000Z");
});

test("feed URLs must use HTTPS and cannot target local addresses", async () => {
  await assert.rejects(() => safeExternalUrl("http://news.example/feed.xml"), /HTTPS/);
  await assert.rejects(() => safeExternalUrl("https://127.0.0.1/feed.xml"), /private network/);
  await assert.rejects(() => safeExternalUrl("https://localhost/feed.xml"), /private network/);
});

test("source fetch concurrency is bounded and results stay in source order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([0, 1, 2, 3, 4], 3, async value => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.equal(peak, 3);
  assert.deepEqual(results, [0, 2, 4, 6, 8]);
});

test("GDELT rate-limit errors skip repeat requests for one minute", () => {
  const source = {
    type: "GDELT",
    lastFetchedAt: new Date(100_000),
    lastFetchError: "Provider returned HTTP 429. Please limit requests to one every 5 seconds."
  };

  assert.equal(gdeltRateLimitCooldownMs(source, 110_000), 50_000);
  assert.equal(gdeltRateLimitCooldownMs(source, 160_000), 0);
  assert.equal(gdeltRateLimitCooldownMs({ ...source, type: "RSS" }, 110_000), 0);
});
