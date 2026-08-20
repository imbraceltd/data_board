import mongoose, { Schema, Document } from 'mongoose';

export interface IOneDriveSubscription extends Document {
  subscriptionId: string;
  sessionId: string;
  resource: string;
  changeType: string;
  notificationUrl: string;
  expirationDateTime: Date;
  clientState: string;
  created_at: Date;
  updated_at: Date;
}

const OneDriveSubscriptionSchema: Schema = new Schema({
  subscriptionId: { type: String, required: true, unique: true },
  sessionId: { type: String, required: true },
  resource: { type: String, required: true },
  changeType: { type: String, required: true, default: 'updated' },
  notificationUrl: { type: String, required: true },
  expirationDateTime: { type: Date, required: true },
  clientState: { type: String, required: true },
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
});

// Update updated_at on save
OneDriveSubscriptionSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

const OneDriveSubscription = mongoose.model<IOneDriveSubscription>('OneDriveSubscription', OneDriveSubscriptionSchema);

export default OneDriveSubscription;
