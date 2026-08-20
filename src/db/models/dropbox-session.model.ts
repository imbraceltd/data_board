import mongoose, { Schema, Document } from 'mongoose';

export interface IDropboxSession extends Document {
  sessionId: string;
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  cursor?: string; // For change tracking
  created_at: Date;
  updated_at: Date;
}

const DropboxSessionSchema: Schema = new Schema({
  sessionId: { type: String, required: true, unique: true },
  access_token: { type: String, required: true },
  refresh_token: { type: String },
  expires_at: { type: Number, required: true },
  cursor: { type: String }, // Cursor for tracking changes
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Update updated_at on save
DropboxSessionSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

export default mongoose.model<IDropboxSession>('DropboxSession', DropboxSessionSchema);
