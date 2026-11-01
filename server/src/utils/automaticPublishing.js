export function isAutomaticPublishingEnabled() {
  return process.env.AI_AUTO_PUBLISH_ENABLED === "true" &&
    process.env.AI_AUTO_PUBLISH_WITHOUT_HUMAN_REVIEW === "true";
}
