import { demoArticles } from "../data/demoArticles.js";

export class MockNewsProvider {
  async discover() {
    return demoArticles.slice(0, 3).map(({ _id, title, summary, category, sourceName, sourceUrl }) => ({
      sourceId: _id,
      title,
      summary,
      category,
      sourceName,
      sourceUrl,
      isDemo: true
    }));
  }
}
