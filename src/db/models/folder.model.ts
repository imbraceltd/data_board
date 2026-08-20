import mongoose, { Schema, Document } from "mongoose";
import { ExternalSource } from "../../core/enums/external-source.enum";

// Enum for folder source types
export enum FolderSourceType {
  UPLOAD = "upload",
  EXTERNAL = "external",
  ASSISTANT = "assistant",
}

export interface IFolder extends Document {
  name: string;
  organization_id: string;
  description?: string;
  tags: string[];
  auto_tagging: boolean;
  parent_folder_id: string;
  source_type: string;
  external_id?: string;
  external_source?: ExternalSource; // Now typed with enum
  session_id?: string; // Link to the OneDrive/Google Drive/Dropbox session
  delta_link?: string;
  synced?: boolean;
  is_sync_enabled?: boolean;
  last_sync_at?: Date;
  sync_timestamp: Date;
  file_count: number;
  path: string;
}

const FolderSchema: Schema = new Schema({
  name: { type: String, required: true },
  organization_id: { type: String, required: true },
  description: { type: String },
  tags: { type: [String], default: [] },
  auto_tagging: { type: Boolean, default: false },
  parent_folder_id: { type: String, required: true },
  source_type: {
    type: String,
    required: true,
    enum: Object.values(FolderSourceType),
  },
  external_id: { type: String },
  external_source: {
    type: String,
    enum: Object.values(ExternalSource), // Restrict to onedrive, google-drive, dropbox
  },
  session_id: { type: String }, // Link to the OneDrive/Google Drive/Dropbox session
  delta_link: { type: String }, // Store delta link for incremental sync
  synced: { type: Boolean, default: true },
  is_sync_enabled: { type: Boolean, default: false },
  last_sync_at: { type: Date },
  sync_timestamp: { type: Date, default: Date.now },
  file_count: { type: Number, default: 0 },
  path: { type: String, required: true },
});

// Update sync_timestamp on save
FolderSchema.pre("save", function (next) {
  this.sync_timestamp = new Date();
  next();
});

const Folder = mongoose.model<IFolder>("Folder", FolderSchema);

export default Folder;
