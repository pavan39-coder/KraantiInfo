import test from "node:test";
import assert from "node:assert/strict";
import { assessAutoDraftCandidate, processCollectedCandidates } from "../src/services/EditorialAutomation.js";

const now = new Date("2026-10-09T00:00:00.000Z");
const candidate = {
  source: { name: "Approved News", reliabilityScore: 80 },
  sourceName: "Approved News",
  title: "A new public transport service begins",
  description: "The city transport authority began a new public bus service on Friday, adding several routes for local commuters.",
  category: "India",
  url: "https://news.example/story",
  publishedAt: "2026-10-08T20:00:00.000Z"
};

test("automatic draft eligibility accepts a recent low-risk candidate with sufficient attribution and metadata", () => {
  assert.equal(assessAutoDraftCandidate(candidate, now), "");
});

test("automatic drafting holds sensitive stories for human review", () => {
  assert.match(assessAutoDraftCandidate({ ...candidate, title: "Court orders investigation in election case" }, now), /sensitive/);
  assert.match(assessAutoDraftCandidate({ ...candidate, category: "Health" }, now), /sensitive/);
  assert.match(assessAutoDraftCandidate({ ...candidate, description: "A new policy debate has emerged around a public technology service, with officials discussing the rules and public access for residents." }, now), /sensitive/);
});

test("automatic drafting holds weak, incomplete, or stale candidates", () => {
  assert.match(assessAutoDraftCandidate({ ...candidate, source: { reliabilityScore: 74 } }, now), /reliability/);
  assert.match(assessAutoDraftCandidate({ ...candidate, description: "Short description" }, now), /enough information/);
  assert.match(assessAutoDraftCandidate({ ...candidate, publishedAt: "2026-10-07T20:00:00.000Z" }, now), /older than 24 hours/);
});

test("scheduled automation stays off unless explicitly enabled", async () => {
  const previousSetting = process.env.AI_AUTO_PROCESSING_ENABLED;
  delete process.env.AI_AUTO_PROCESSING_ENABLED;
  try {
    assert.deepEqual(await processCollectedCandidates(), { enabled: false, processed: 0, published: 0, review: 0 });
  } finally {
    if (previousSetting !== undefined) process.env.AI_AUTO_PROCESSING_ENABLED = previousSetting;
  }
});

test("scheduled automation asks AI to select and draft one candidate, then sends it to human review", async () => {
  const previousSetting = process.env.AI_AUTO_PROCESSING_ENABLED;
  process.env.AI_AUTO_PROCESSING_ENABLED = "true";
  const candidates = Array.from({ length: 4 }, (_, index) => ({
    ...candidate,
    _id: `candidate-${index}`,
    source: { ...candidate.source },
    publishedAt: new Date(now.getTime() - index * 60_000)
  }));
  const created = [];
  const updated = [];
  const candidateModel = {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        populate() { return this; },
        lean: async () => candidates
      };
    },
    updateOne: async (query, update) => updated.push({ query, update })
  };
  const articleModel = {
    findOne: () => ({ select() { return this; }, lean: async () => null }),
    create: async article => {
      created.push(article);
      return { _id: `article-${created.length}` };
    }
  };
  try {
    const result = await processCollectedCandidates({
      now,
      candidateModel,
      articleModel,
      selectionDraftGenerator: async items => ({
        selectedCandidateId: String(items[1]._id),
        selectionScore: 91,
        selectionReason: "Strong public relevance.",
        title: "A useful local service update",
        summary: "A supported short summary.",
        body: "A supported short report.",
        category: "India",
        verificationNotes: "Check the linked source."
      })
    });
    assert.equal(result.processed, 1);
    assert.equal(result.published, 0);
    assert.equal(result.review, 1);
    assert.equal(result.selectionScore, 91);
    assert.equal(created.length, 1);
    assert.equal(String(created[0].sourceArticle), "candidate-1");
    assert.equal(created[0].autoPublished, false);
    assert.equal(created[0].status, "review");
    assert.equal(updated.length, 1);
  } finally {
    if (previousSetting === undefined) delete process.env.AI_AUTO_PROCESSING_ENABLED;
    else process.env.AI_AUTO_PROCESSING_ENABLED = previousSetting;
  }
});

test("all automatically generated stories remain in editorial review, including sensitive copy", async () => {
  const previousSetting = process.env.AI_AUTO_PROCESSING_ENABLED;
  process.env.AI_AUTO_PROCESSING_ENABLED = "true";
  const candidates = [{ ...candidate, _id: "sensitive-candidate", source: { ...candidate.source } }];
  let created;
  const candidateModel = {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        populate() { return this; },
        lean: async () => candidates
      };
    },
    updateOne: async () => {}
  };
  const articleModel = {
    findOne: () => ({ select() { return this; }, lean: async () => null }),
    create: async article => { created = article; return { _id: "review-article" }; }
  };
  try {
    const result = await processCollectedCandidates({
      now,
      candidateModel,
      articleModel,
      selectionDraftGenerator: async items => ({
        selectedCandidateId: String(items[0]._id),
        selectionScore: 80,
        selectionReason: "Selected for review.",
        title: "The court reviews a local matter",
        summary: "A short report.",
        body: "The source describes a court proceeding.",
        category: "India",
        verificationNotes: "Verify the details."
      })
    });
    assert.equal(result.published, 0);
    assert.equal(result.review, 1);
    assert.equal(created.status, "review");
    assert.equal(created.autoPublished, false);
  } finally {
    if (previousSetting === undefined) delete process.env.AI_AUTO_PROCESSING_ENABLED;
    else process.env.AI_AUTO_PROCESSING_ENABLED = previousSetting;
  }
});

test("automatic publishing accepts reliability 75 only when the other recent, detailed, low-risk gates pass", async () => {
  const previousProcessing = process.env.AI_AUTO_PROCESSING_ENABLED;
  const previousPublishing = process.env.AI_AUTO_PUBLISH_ENABLED;
  process.env.AI_AUTO_PROCESSING_ENABLED = "true";
  process.env.AI_AUTO_PUBLISH_ENABLED = "true";
  const publishable = {
    ...candidate,
    description: "A detailed report explains a new public technology service announced today, how residents can access it, the locations where it is available, and the schedule for its rollout across the city. The service is intended to improve access to local information and public facilities.",
    category: "Technology",
    source: { name: "Approved News", reliabilityScore: 75 },
    publishedAt: new Date(now.getTime() - 60 * 60 * 1000)
  };
  const created = [];
  const candidateModel = {
    find() {
      return { sort() { return this; }, limit() { return this; }, populate() { return this; }, lean: async () => [{ ...publishable, _id: "publishable-candidate" }] };
    },
    updateOne: async (_query, update) => assert.equal(update.$set.status, "published")
  };
  const articleModel = {
    findOne: () => ({ select() { return this; }, lean: async () => null }),
    create: async article => { created.push(article); return { _id: "published-article" }; }
  };
  try {
    const result = await processCollectedCandidates({
      now,
      candidateModel,
      articleModel,
      selectionDraftGenerator: async items => ({
        selectedCandidateId: String(items[0]._id),
        selectionScore: 90,
        selectionReason: "Specific and timely public interest.",
        title: "A public technology service expands access",
        summary: "A city announced a new digital service for residents.",
        body: "The city announced a new digital service for residents. The source says it will be available at several local facilities and provides a schedule for its rollout. Residents can check the linked source for the details and access information. The announcement describes the service as a way to make public information easier to reach.",
        category: "Technology",
        verificationNotes: "Original source only; independent verification is outstanding."
      })
    });
    assert.equal(result.published, 1);
    assert.equal(result.review, 0);
    assert.equal(result.autoPublished, true);
    assert.equal(created[0].status, "published");
    assert.equal(created[0].autoPublished, true);
    assert.match(created[0].verificationNotes, /automatically published/i);
  } finally {
    if (previousProcessing === undefined) delete process.env.AI_AUTO_PROCESSING_ENABLED;
    else process.env.AI_AUTO_PROCESSING_ENABLED = previousProcessing;
    if (previousPublishing === undefined) delete process.env.AI_AUTO_PUBLISH_ENABLED;
    else process.env.AI_AUTO_PUBLISH_ENABLED = previousPublishing;
  }
});

test("failed provider drafts are reported so editors can see why automation did not create a draft", async () => {
  const previousSetting = process.env.AI_AUTO_PROCESSING_ENABLED;
  process.env.AI_AUTO_PROCESSING_ENABLED = "true";
  const candidateModel = {
    find() {
      return {
        sort() { return this; },
        limit() { return this; },
        populate() { return this; },
        lean: async () => [{ ...candidate, _id: "failed-candidate", source: { ...candidate.source } }]
      };
    }
  };
  const articleModel = {
    findOne: () => ({ select() { return this; }, lean: async () => null })
  };
  try {
    const result = await processCollectedCandidates({
      now,
      candidateModel,
      articleModel,
      selectionDraftGenerator: async () => { throw new Error("The AI provider returned an incomplete article draft. Please retry."); }
    });
    assert.equal(result.enabled, true);
    assert.equal(result.eligible, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(result.failures, [{ error: "The AI provider returned an incomplete article draft. Please retry." }]);
  } finally {
    if (previousSetting === undefined) delete process.env.AI_AUTO_PROCESSING_ENABLED;
    else process.env.AI_AUTO_PROCESSING_ENABLED = previousSetting;
  }
});
