import mongoose, { Schema, Document } from "mongoose";

export interface IGoogleDriveSession extends Document {
  sessionId: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  start_page_token?: string; // For change tracking
  organization_id?: string; // For multi-account support
  user_info?: {
    displayName?: string;
    email?: string;
  };
  channel_id?: string; // For webhook subscriptions
  channel_resource_id?: string; // For webhook subscriptions
  created_at: Date;
  updated_at: Date;
}

const GoogleDriveSessionSchema: Schema = new Schema({
  sessionId: { type: String, required: true, unique: true },
  access_token: { type: String, required: true },
  refresh_token: { type: String },
  expires_at: { type: Number, required: true },
  start_page_token: { type: String }, // Page token for change tracking
  organization_id: { type: String }, // For multi-account support
  user_info: {
    displayName: { type: String },
    email: { type: String },
  },
  channel_id: { type: String }, // Used for webhook subscriptions
  channel_resource_id: { type: String }, // Used for webhook subscriptions
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// Update updated_at on save
GoogleDriveSessionSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

export default mongoose.model<IGoogleDriveSession>(
  "GoogleDriveSession",
  GoogleDriveSessionSchema
);
