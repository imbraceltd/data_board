import mongoose, { Schema, Document } from 'mongoose';

export interface IUser {
  display_name: string;
  email: string;
}

export interface IBoardUploadFile extends Document {
  name: string;
  organization_id: string;
  board_id: string;
  last_updated_by: IUser;
  sync_timestamp: Date;
  key: string;
  file_type: string;
  file_size: number;
}

const UserSchema = new Schema({
  display_name: { type: String, required: true },
  email: { type: String, required: true },
}, { _id: false });

const BoardUploadFileSchema: Schema = new Schema({
  name: { type: String, required: true },
  organization_id: { type: String, required: true },
  board_id: { type: String, required: true },
  last_updated_by: { type: UserSchema, required: true },
  sync_timestamp: { type: Date, default: Date.now },
  key: { type: String, required: true },
  file_type: { type: String, required: true },
  file_size: { type: Number, required: true },
});

const BoardUploadFile  = mongoose.model<IBoardUploadFile>('BoardUploadFile', BoardUploadFileSchema);

export default BoardUploadFile ;
