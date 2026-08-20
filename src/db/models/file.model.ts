import mongoose, { Schema, Document } from "mongoose";
import { ExternalSource } from "../../core/enums/external-source.enum";

export interface IFile extends Document {
  name: string;
  organization_id: string;
  folder_id: string;
  source_type: string;
  external_id?: string;
  external_source?: ExternalSource; // Now typed with enum
  synced?: boolean;
  last_sync_at?: Date;
  key: string;
  file_type: string;
  file_size: number;
  tags?: string[]; // Array of tags
  remarks?: string; // User notes/comments about the file
  last_updated_by?: {
    display_name: string;
    email: string;
  };
  created_at: Date;
  updated_at: Date;
}

const FileSchema: Schema = new Schema({
  name: { type: String, required: true },
  organization_id: { type: String, required: true },
  folder_id: { type: String, required: true },
  source_type: { type: String, required: true, default: "local" },
  external_id: { type: String },
  external_source: {
    type: String,
    enum: Object.values(ExternalSource), // Restrict to onedrive, google-drive, dropbox
  },
  synced: { type: Boolean, default: true },
  last_sync_at: { type: Date },
  key: { type: String, required: true },
  file_type: { type: String, required: true },
  file_size: { type: Number, required: true },
  tags: { type: [String], default: [] }, // Array of tags
  remarks: { type: String }, // User notes/comments
  last_updated_by: {
    display_name: { type: String },
    email: { type: String },
  },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// Update updated_at on save
FileSchema.pre("save", function (next) {
  this.updated_at = new Date();
  next();
});

const File = mongoose.model<IFile>("File", FileSchema);

export default File;
