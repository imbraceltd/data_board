import mongoose, { Schema, Document } from "mongoose";

export interface IIngestionJob extends Document {
  fileId: string;
  status: "pending" | "in_progress" | "done" | "error";
  errorMessage?: string;
  errorCode?: string;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const IngestionJobSchema: Schema = new Schema(
  {
    fileId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "in_progress", "done", "error"],
      default: "pending",
      required: true,
    },
    errorMessage: { type: String },
    errorCode: { type: String },
    retryCount: { type: Number, default: 0 },
    maxRetries: { type: Number, default: 3 },
    nextRetryAt: { type: Date },
    lastError: { type: String },
  },
  {
    timestamps: true, // This adds createdAt and updatedAt automatically
  },
);

// Add index for efficient querying of pending jobs
IngestionJobSchema.index({ status: 1, createdAt: 1 });

const IngestionJob = mongoose.model<IIngestionJob>(
  "IngestionJob",
  IngestionJobSchema,
);

export default IngestionJob;
