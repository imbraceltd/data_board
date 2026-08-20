import mongoose, { Schema, Document } from 'mongoose';

export interface IOneDriveSession extends Document {
  sessionId: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  expires_in?: number;
  organization_id?: string;
  user_info?: {
    displayName?: string;
    email?: string;
  };
  // Postgres stores user info as flat columns (the legacy Mongoose store nested
  // it under `user_info`). Optional so both stores type-check.
  user_email?: string;
  user_display_name?: string;
  created_at: Date;
  updated_at: Date;
}

const OneDriveSessionSchema: Schema = new Schema({
  sessionId: { type: String, required: true, unique: true },
  access_token: { type: String, required: true },
  refresh_token: { type: String },
  expires_at: { type: Number, required: true },
  expires_in: { type: Number },
  organization_id: { type: String },
  user_info: {
    displayName: { type: String },
    email: { type: String }
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Update updated_at on save
OneDriveSessionSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default mongoose.model<IOneDriveSession>('OneDriveSession', OneDriveSessionSchema);
