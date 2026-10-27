import Article from "../models/Article.js";
import EditorialAutomationState from "../models/EditorialAutomationState.js";
import SourceArticle from "../models/SourceArticle.js";
import { generateEditorialDraft } from "./EditorialDraftAgent.js";
import { publishArticleToBlogger } from "./BloggerPublisher.js";
import { countWords, MINIMUM_ARTICLE_WORDS } from "../utils/wordCount.js";

const MIN_SOURCE_RELIABILITY = 75;
const MAX_SOURCE_AGE_MS = 24 * 60 * 60 * 1000;
const AUTO_PUBLISH_MIN_RELIABILITY = 75;
const AUTO_PUBLISH_MAX_SOURCE_AGE_MS = 24 * 60 * 60 * 1000;
const AUTO_PUBLISH_MIN_DESCRIPTION_LENGTH = 80;
const MAX_CANDIDATES_PER_SELECTION = 20;
const SCHEDULED_PROCESSING_STATE_KEY = "scheduled-ai-processing";
const sensitiveContent = /\b(election|politic(?:al|s|ian|ians)?|policy|crime|health|murder|assault|arrest|fatal|death|disease|suicide|terror(?:ism)?|war|conflict|disaster|scam|fraud|lawsuit|court|stock market|banking crisis|interest rate|investment advice)\b/i;
let automationInProgress = false;

function scheduledProcessingCooldownMs() {
  const configuredHours = Number(process.env.AI_AUTO_PROCESSING_COOLDOWN_HOURS) || 12;
  return Math.min(Math.max(configuredHours, 1), 24) * 60 * 60 * 1000;
}

export function assessAutoDraftCandidate(candidate, now = new Date()) {
  const source = candidate.source;
  if (!source || source.reliabilityScore < MIN_SOURCE_RELIABILITY) return "Source reliability is below the automatic processing threshold.";
  if (!candidate.sourceName && !source.name) return "Source attribution is missing.";
  if (!candidate.url || !candidate.title) return "A source URL or headline is missing.";
  if ((typeof candidate.description !== "string" || candidate.description.trim().length < 80) && countWords(candidate.contentText) < 100) {
    return "The source has too little detail for a useful AI article; this candidate will stay in the collected queue.";
  }
  const publishedAt = candidate.publishedAt ? new Date(candidate.publishedAt) : null;
  if (!publishedAt || Number.isNaN(publishedAt.getTime()) || publishedAt > now || now - publishedAt > MAX_SOURCE_AGE_MS) {
    return "The source publication time is missing, invalid, or older than 24 hours.";
  }
  if (sensitiveContent.test(`${candidate.category} ${candidate.title} ${candidate.description}`)) {
    return "The source may cover a sensitive or high-impact topic and requires editorial review.";
  }
  return "";
}

export function assessAutoPublishCandidate(candidate, draft, now = new Date()) {
  if (process.env.AI_AUTO_PUBLISH_ENABLED !== "true") return "Automatic publishing is disabled.";
  const draftEligibilityIssue = assessAutoDraftCandidate(candidate, now);
  if (draftEligibilityIssue) return draftEligibilityIssue;
  if ((candidate.source?.reliabilityScore || 0) < AUTO_PUBLISH_MIN_RELIABILITY) return "Source reliability is below the automatic publishing threshold.";
  if (countWords(candidate.contentText) < MINIMUM_ARTICLE_WORDS) return "The AI used source metadata for this long-form explainer; human review is required before publishing.";
  if (typeof candidate.description !== "string" || candidate.description.trim().length < AUTO_PUBLISH_MIN_DESCRIPTION_LENGTH) {
    return "The source description is too short for automatic publishing.";
  }
  const publishedAt = new Date(candidate.publishedAt);
  if (now - publishedAt > AUTO_PUBLISH_MAX_SOURCE_AGE_MS) return "The source is older than the automatic publishing window.";
  if (["Politics", "Health"].includes(draft.category)) return "This category requires editorial review before publishing.";
  if (sensitiveContent.test(`${candidate.category} ${candidate.title} ${candidate.description} ${draft.category} ${draft.title} ${draft.summary} ${draft.body}`)) {
    return "The source or generated copy may cover a sensitive or high-impact topic.";
  }
  if (!Number.isFinite(draft.selectionScore) || draft.selectionScore < 0 || draft.selectionScore > 100) return "The AI did not return a valid selection score.";
  if (countWords(draft.body) < MINIMUM_ARTICLE_WORDS) return `The generated report is below the ${MINIMUM_ARTICLE_WORDS}-word minimum.`;
  return "";
}

function compareCandidatePriority(left, right) {
  const reliabilityDifference = (right.source?.reliabilityScore || 0) - (left.source?.reliabilityScore || 0);
  if (reliabilityDifference) return reliabilityDifference;
  // If two sources are similarly trusted, give the AI a better chance to pick
  // a story that can support a substantial report and useful reader media.
  const reportingMaterialDifference = countWords(right.contentText) - countWords(left.contentText);
  if (reportingMaterialDifference) return reportingMaterialDifference;
  const mediaDifference = Number(Boolean(right.imageUrl || right.videoUrl)) - Number(Boolean(left.imageUrl || left.videoUrl));
  if (mediaDifference) return mediaDifference;
  const freshnessDifference = new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime();
  if (freshnessDifference) return freshnessDifference;
  return right.description.length - left.description.length;
}

export async function processCollectedCandidates({
  now = new Date(),
  draftLanguage = process.env.AI_AUTO_DRAFT_LANGUAGE,
  scheduled = false,
  draftGenerator = generateEditorialDraft,
  bloggerPublisher = publishArticleToBlogger,
  candidateModel = SourceArticle,
  articleModel = Article,
  automationStateModel = EditorialAutomationState
} = {}) {
  const outputLanguage = draftLanguage === "en" ? "en" : "hi";
  if (process.env.AI_AUTO_PROCESSING_ENABLED !== "true") {
    return { enabled: false, processed: 0, published: 0, review: 0 };
  }
  if (automationInProgress) return { enabled: true, skipped: "Editorial automation is already running.", processed: 0, published: 0, review: 0 };

  automationInProgress = true;
  let considered = 0;
  let eligibleCount = 0;
  try {
    if (scheduled) {
      const state = await automationStateModel.findOne({ key: SCHEDULED_PROCESSING_STATE_KEY })
        .select("lastScheduledAttemptAt")
        .lean();
      const lastAttemptAt = state?.lastScheduledAttemptAt ? new Date(state.lastScheduledAttemptAt).getTime() : 0;
      if (lastAttemptAt && now.getTime() - lastAttemptAt < scheduledProcessingCooldownMs()) {
        return { enabled: true, skipped: "Scheduled AI processing is cooling down; manual draft generation remains available.", processed: 0, published: 0, review: 0 };
      }
    }

    const candidates = await candidateModel.find({ status: "collected" })
      .sort({ publishedAt: -1, collectedAt: -1 })
      .limit(100)
      .populate("source", "name reliabilityScore")
      .lean();
    considered = candidates.length;
    const eligible = candidates
      .filter(candidate => !assessAutoDraftCandidate(candidate, now))
      .sort(compareCandidatePriority)
      .slice(0, MAX_CANDIDATES_PER_SELECTION);
    eligibleCount = eligible.length;
    if (!eligible.length) {
      return { enabled: true, considered: candidates.length, eligible: 0, processed: 0, published: 0, review: 0, failed: 0, failures: [] };
    }

    // Remove items already linked to a story before the single model call for this cycle.
    const unseen = [];
    for (const candidate of eligible) {
      const existingArticle = await articleModel.findOne({ sourceArticle: candidate._id }).select("status").lean();
      if (existingArticle) {
        await candidateModel.updateOne({ _id: candidate._id, status: "collected" }, { $set: { status: existingArticle.status } });
      } else {
        unseen.push(candidate);
      }
    }
    if (!unseen.length) {
      return { enabled: true, considered: candidates.length, eligible: eligible.length, processed: 0, published: 0, review: 0, failed: 0, failures: [] };
    }

    // The queue is already ranked by source reliability, permitted reporting detail,
    // useful media, and freshness. Use that ranking instead of spending a second
    // model request just to choose a story.
    const candidate = unseen[0];
    const selection = {
      selectedCandidateId: String(candidate._id),
      selectionReason: "Ranked by source reliability, permitted reporting detail, media, and freshness.",
      selectionScore: candidate.source.reliabilityScore
    };
    if (scheduled) {
      await automationStateModel.updateOne(
        { key: SCHEDULED_PROCESSING_STATE_KEY },
        { $set: { lastScheduledAttemptAt: now }, $setOnInsert: { key: SCHEDULED_PROCESSING_STATE_KEY } },
        { upsert: true }
      );
    }
    const generated = {
      ...await draftGenerator(candidate, { language: outputLanguage }),
      selectedCandidateId: selection.selectedCandidateId,
      selectionReason: selection.selectionReason,
      selectionScore: selection.selectionScore
    };
    const autoPublishReviewReason = assessAutoPublishCandidate(candidate, generated, now);
    const shouldAutoPublish = !autoPublishReviewReason;
    const sourceBasisDisclosure = countWords(candidate.contentText) >= MINIMUM_ARTICLE_WORDS
      ? "AI-assisted draft based on the source's permitted full text; not independently verified."
      : "AI-authored explainer based on the source headline/description with contextual analysis; not independently verified and requires human review.";
    const article = await articleModel.create({
      sourceArticle: candidate._id,
      title: generated.title,
      summary: generated.summary,
      body: generated.body,
      verificationNotes: [
        generated.verificationNotes,
        `Automation priority (${generated.selectionScore}/100): ${generated.selectionReason}`,
        shouldAutoPublish
          ? `Automation disclosure: ${sourceBasisDisclosure}`
          : `Automation disclosure: ${sourceBasisDisclosure} Review required. ${autoPublishReviewReason}`
      ].filter(Boolean).join("\n\n"),
      category: generated.category,
      author: "KraantiInfo AI Desk",
      aiAssisted: true,
      autoPublished: shouldAutoPublish,
      sourceName: candidate.sourceName || candidate.source?.name,
      sourceUrl: candidate.url,
      image: candidate.imageUrl,
      imageAlt: candidate.title,
      videoUrl: candidate.videoUrl,
      language: outputLanguage,
      tags: [...new Set([generated.category, ...(Array.isArray(generated.seoKeywords) ? generated.seoKeywords : [])])],
      status: shouldAutoPublish ? "published" : "review",
      publishedAt: shouldAutoPublish ? now : undefined
    });
    const finalStatus = shouldAutoPublish ? "published" : "review";
    await candidateModel.updateOne({ _id: candidate._id, status: "collected" }, { $set: { status: finalStatus } });
    let blogger = { status: "skipped" };
    if (shouldAutoPublish) {
      try {
        blogger = await bloggerPublisher(article);
      } catch (error) {
        // Blogger is a secondary destination; a Blogger outage must not undo the
        // successful KraantiInfo publication. The article stores the sync failure.
        blogger = { status: "failed", error: error.message };
        console.error(`Blogger sync failed for KraantiInfo article ${article._id}: ${error.message}`);
      }
    }
    console.log(`Editorial automation ${shouldAutoPublish ? "auto-published" : "drafted for review"} candidate ${candidate._id} as article ${article._id}.`);
    return {
      enabled: true,
      considered: candidates.length,
      eligible: unseen.length,
      processed: 1,
      published: shouldAutoPublish ? 1 : 0,
      review: shouldAutoPublish ? 0 : 1,
      autoPublished: shouldAutoPublish,
      blogger,
      autoPublishReviewReason: shouldAutoPublish ? "" : autoPublishReviewReason,
      selectedCandidateId: String(candidate._id),
      selectionScore: generated.selectionScore,
      selectionReason: generated.selectionReason,
      model: generated.model,
      language: outputLanguage,
      failed: 0,
      failures: []
    };
  } catch (error) {
    return {
      enabled: true,
      considered,
      eligible: eligibleCount,
      processed: 0,
      published: 0,
      review: 0,
      failed: 1,
      failures: [{ error: error.message }]
    };
  } finally {
    automationInProgress = false;
  }
}

