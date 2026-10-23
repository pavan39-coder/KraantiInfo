export function brandedAuthor(author, fallback = "KraantiInfo Desk") {
  if (typeof author !== "string" || !author.trim()) return fallback;
  return author.replace(/wakeup\\s*india/gi, "KraantiInfo");
}
