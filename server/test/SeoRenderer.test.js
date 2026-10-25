import test from "node:test";
import assert from "node:assert/strict";
import { createSitemapXml, renderArticleSeoPage } from "../src/services/SeoRenderer.js";

const article = {
  _id: "6ade7bee80cbe52b052b5f26",
  title: "खबर में <script>alert(1)</script>",
  summary: "यह एक संक्षिप्त सारांश है।",
  body: "पहला अनुच्छेद।\n\nदूसरा अनुच्छेद।",
  category: "India",
  author: "KraantiInfo Desk",
  language: "hi",
  sourceName: "Example News",
  sourceUrl: "https://example.com/story",
  publishedAt: "2026-10-25T10:00:00.000Z",
  updatedAt: "2026-10-26T10:00:00.000Z"
};

test("article SEO HTML includes unique canonical metadata, NewsArticle schema, and safe article data", () => {
  const shell = '<!doctype html><html lang="en"><head><title>Home</title></head><body><div id="root"></div></body></html>';
  const html = renderArticleSeoPage({ shell, article });

  assert.match(html, /<html lang="hi">/);
  assert.match(html, /<title>खबर में &lt;script&gt;alert\(1\)&lt;\/script&gt; \| KraantiInfo<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.kraantiinfo\.in\/article\/6ade7bee80cbe52b052b5f26"/);
  assert.match(html, /<script type="application\/ld\+json">[\s\S]*?"@type":"NewsArticle"/);
  assert.match(html, /<h1>खबर में &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
  assert.doesNotMatch(html, /<h1>खबर में <script>/);
  const articleData = html.match(/<script id="seo-article-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(articleData);
  assert.equal(JSON.parse(articleData)._id, article._id);
  assert.doesNotMatch(articleData, /<script>/i);
});

test("sitemap lists the canonical homepage, categories, and published articles only", () => {
  const xml = createSitemapXml({
    siteOrigin: "https://www.kraantiinfo.in/path/",
    categories: ["India", "World"],
    articles: [
      { _id: "published-1", status: "published", category: "India", publishedAt: "2026-10-26T10:00:00.000Z" },
      { _id: "draft-1", status: "draft", category: "World", publishedAt: "2026-10-26T11:00:00.000Z" }
    ]
  });

  assert.match(xml, /<loc>https:\/\/www\.kraantiinfo\.in\/article\/published-1<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.kraantiinfo\.in\/category\/india<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.kraantiinfo\.in\/category\/world<\/loc>/);
  assert.match(xml, /<loc>https:\/\/www\.kraantiinfo\.in\/<\/loc>/);
  assert.doesNotMatch(xml, /draft-1/);
});
