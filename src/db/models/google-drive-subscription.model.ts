import mongoose, { Schema, Document } from 'mongoose';

export interface IGoogleDriveSubscription extends Document {
  sessionId: string;
  webhookUrl: string;
  channelId: string; // Unique identifier for this notification channel
  resourceId: string; // Google's resource ID for this channel
  startPageToken: string; // Page token when this subscription started
  expirationDateTime: Date;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

const GoogleDriveSubscriptionSchema: Schema = new Schema({
  sessionId: { type: String, required: true },
  webhookUrl: { type: String, required: true },
  channelId: { type: String, required: true, unique: true },
  resourceId: { type: String, required: true },
  startPageToken: { type: String, required: true },
  expirationDateTime: { type: Date, required: true },
  active: { type: Boolean, default: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Update updated_at on save
GoogleDriveSubscriptionSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default mongoose.model<IGoogleDriveSubscription>('GoogleDriveSubscription', GoogleDriveSubscriptionSchema);
