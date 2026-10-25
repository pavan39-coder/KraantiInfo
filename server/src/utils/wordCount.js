export const MINIMUM_ARTICLE_WORDS = 500;

// Include Unicode combining marks so Hindi words (which use matras/diacritics)
// are counted as one word instead of several fragments.
export function countWords(value) {
  if (typeof value !== "string") return 0;
  return (value.match(/[\p{L}\p{M}\p{N}]+(?:[’'][\p{L}\p{M}\p{N}]+)*/gu) || []).length;
}
