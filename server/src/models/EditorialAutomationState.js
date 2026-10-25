import mongoose from "mongoose";

const editorialAutomationStateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    lastScheduledAttemptAt: { type: Date, default: null }
  },
  { timestamps: true }
);

export default mongoose.model("EditorialAutomationState", editorialAutomationStateSchema);
